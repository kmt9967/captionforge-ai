import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { NextResponse } from "next/server";
import type {
  CaptionRequestFrame,
  CaptionRequestPayload,
} from "@/lib/caption-contract";

export const runtime = "nodejs";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const JUDGE_VISION_MODEL = "accounts/fireworks/models/minimax-m3";
const DEFAULT_TEXT_MODEL = "accounts/fireworks/models/deepseek-v4-pro";
const VISION_CALL_TIMEOUT_MS = 10_000;
const TEXT_CALL_TIMEOUT_MS = 12_000;
const MAX_FRAMES = 5;
const MAX_FRAME_CHARS = 800_000;
const MAX_TOTAL_FRAME_CHARS = 2_500_000;

const briefKeys = [
  "visible_objects",
  "visible_people",
  "clothing",
  "actions",
  "background",
  "readable_text",
  "scene_changes",
  "uncertain_details",
] as const;

const captionKeys = [
  "formal",
  "sarcastic",
  "humorous_tech",
  "humorous_non_tech",
] as const;

const technicalConcepts = [
  "algorithm",
  "cpu",
  "gpu",
  "code",
  "server",
  "update",
  "loading",
  "deployment",
  "bug",
  "bandwidth",
  "debug",
] as const;

const stopWords = new Set([
  "about",
  "after",
  "along",
  "also",
  "and",
  "are",
  "around",
  "before",
  "behind",
  "beside",
  "between",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "near",
  "over",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "through",
  "under",
  "with",
]);

type BriefKey = (typeof briefKeys)[number];
type CaptionKey = (typeof captionKeys)[number];
type VisualBrief = Record<BriefKey, string[]>;
type JudgeCaptions = Record<CaptionKey, string>;
type ValidationCode =
  | "invalid_json"
  | "too_similar"
  | "tech_missing"
  | "sarcasm_missing"
  | "style_mismatch"
  | "grounding_failure"
  | "unsupported_claim"
  | "length_failure";

type ValidationIssue = {
  code: ValidationCode;
  message: string;
};

class CaptionValidationError extends Error {
  issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "CaptionValidationError";
    this.issues = issues;
  }
}

const GENERIC_SAFE_CAPTIONS: JudgeCaptions = {
  formal:
    "The sampled frames require human review before a precise and visually grounded caption can be published safely.",
  sarcastic:
    "Apparently the sampled frames chose mystery today, so human review gets the wonderfully glamorous job of adding specifics.",
  humorous_tech:
    "The visual server returned insufficient evidence, so the caption algorithm deployed a careful request for human review.",
  humorous_non_tech:
    "The frames kept their secrets, leaving the caption desk to politely ask a human for the missing details.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedDataImage(value: string) {
  return /^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=]+$/i.test(
    value,
  );
}

function readFrame(value: unknown): CaptionRequestFrame | null {
  if (!isRecord(value)) {
    return null;
  }

  const dataUrl = typeof value.dataUrl === "string" ? value.dataUrl.trim() : "";
  const timestamp =
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    value.timestamp >= 0
      ? Math.round(value.timestamp * 10) / 10
      : 0;

  return { dataUrl, timestamp };
}

function validatePayload(payload: unknown):
  | { ok: true; value: CaptionRequestPayload }
  | { ok: false; error: string } {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  if (!Array.isArray(payload.frames) || payload.frames.length !== MAX_FRAMES) {
    return { ok: false, error: `Exactly ${MAX_FRAMES} frames are required.` };
  }

  const frames = payload.frames.map(readFrame);

  if (frames.some((frame) => frame === null)) {
    return { ok: false, error: "Frames must include image data and timestamps." };
  }

  const normalizedFrames = frames as CaptionRequestFrame[];

  if (normalizedFrames.some((frame) => !isSupportedDataImage(frame.dataUrl))) {
    return { ok: false, error: "Frames must be base64 image data URLs." };
  }

  if (normalizedFrames.some((frame) => frame.dataUrl.length > MAX_FRAME_CHARS)) {
    return { ok: false, error: "One or more frames are too large." };
  }

  const totalChars = normalizedFrames.reduce(
    (total, frame) => total + frame.dataUrl.length,
    0,
  );

  if (totalChars > MAX_TOTAL_FRAME_CHARS) {
    return { ok: false, error: "Combined frame data is too large." };
  }

  return {
    ok: true,
    value: {
      frames: normalizedFrames,
      context: "",
      videoFileName:
        typeof payload.videoFileName === "string"
          ? payload.videoFileName.slice(0, 180)
          : "judge-video",
      videoDuration:
        typeof payload.videoDuration === "number" &&
        Number.isFinite(payload.videoDuration) &&
        payload.videoDuration > 0
          ? payload.videoDuration
          : null,
    },
  };
}

function parseJsonObject(rawText: string): Record<string, unknown> | null {
  const cleaned = rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    return isRecord(parsed) ? parsed : null;
  } catch {
    const startIndexes: number[] = [];
    const endIndexes: number[] = [];

    for (let index = 0; index < cleaned.length; index += 1) {
      if (cleaned[index] === "{") {
        startIndexes.push(index);
      }

      if (cleaned[index] === "}") {
        endIndexes.push(index);
      }
    }

    for (const startIndex of startIndexes) {
      for (const endIndex of endIndexes) {
        if (endIndex <= startIndex) {
          continue;
        }

        try {
          const parsed = JSON.parse(cleaned.slice(startIndex, endIndex + 1));

          if (isRecord(parsed)) {
            return parsed;
          }
        } catch {
          // Keep scanning for a valid object inside model reasoning or prose.
        }
      }
    }

    return null;
  }
}

function normalizeBrief(rawText: string): VisualBrief {
  const parsed = parseJsonObject(rawText);

  if (!parsed) {
    throw new Error("Vision model returned invalid JSON.");
  }

  const brief = Object.fromEntries(
    briefKeys.map((key) => {
      const value = parsed[key];

      if (!Array.isArray(value)) {
        throw new Error(`Visual brief is missing ${key}.`);
      }

      const items = value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 120))
        .filter(Boolean)
        .filter(
          (item) =>
            key === "readable_text" ||
            key === "uncertain_details" ||
            !unsupportedClaim(item),
        )
        .slice(0, 12);

      return [key, items];
    }),
  ) as VisualBrief;

  if (groundingDetails(brief).length < 2) {
    throw new Error("Visual brief contains too little verified evidence.");
  }

  return brief;
}

function normalizeCaptions(rawText: string): JudgeCaptions {
  const parsed = parseJsonObject(rawText);

  if (!parsed) {
    throw new CaptionValidationError([
      { code: "invalid_json", message: "Caption response is not valid JSON." },
    ]);
  }

  const captions = {} as JudgeCaptions;
  const issues: ValidationIssue[] = [];

  for (const key of captionKeys) {
    const value = parsed[key];

    if (typeof value !== "string" || !value.trim()) {
      issues.push({
        code: "invalid_json",
        message: `Caption response is missing ${key}.`,
      });
      continue;
    }

    captions[key] = value.replace(/\s+/g, " ").trim();
  }

  if (issues.length > 0) {
    throw new CaptionValidationError(issues);
  }

  return captions;
}

function groundingDetails(brief: VisualBrief) {
  return briefKeys
    .filter((key) => key !== "uncertain_details")
    .flatMap((key) => brief[key])
    .map((detail) => detail.trim())
    .filter(Boolean);
}

function words(value: string) {
  return value.toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)?/g) || [];
}

function contentWords(value: string) {
  return words(value).filter(
    (word) => word.length >= 3 && !stopWords.has(word),
  );
}

function jaccardSimilarity(left: string, right: string) {
  const leftWords = new Set(contentWords(left));
  const rightWords = new Set(contentWords(right));
  const union = new Set([...leftWords, ...rightWords]);

  if (union.size === 0) {
    return 0;
  }

  const intersection = [...leftWords].filter((word) => rightWords.has(word));
  return intersection.length / union.size;
}

function containsTechnicalConcept(caption: string) {
  const captionWords = new Set(words(caption));
  return technicalConcepts.some((concept) => captionWords.has(concept));
}

function hasSarcasticConstruction(caption: string) {
  return /\b(apparently|clearly|of course|sure|naturally|totally|because nothing says|as if|subtle|what a surprise)\b/i.test(
    caption,
  );
}

function hasEverydayHumor(caption: string) {
  return /\b(like|apparently|somehow|decided|pretending|plot twist|because|when|while|just|as if|seems?|staring contest|winning|losing|trying|forgot|waiting|showed up|turned into|playing|game|follow-the-leader|party|dance|racing|conspired)\b/i.test(
    caption,
  );
}

function unsupportedClaim(caption: string) {
  const patterns = [
    /\b(audio|voice|vocals?|pitch|singing|sang|sung|music|sound|speech|spoken|speaking|heard|hearing|listening|lyrics?)\b/i,
    /\b(happy|sad|angry|excited|nervous|afraid|confident|confidence|anxious|proud|lonely|bored|surprised)\b/i,
    /\b(man|woman|boy|girl|male|female|child|teenager|elderly|youngster)\b/i,
    /\b(muslim|christian|hindu|jewish|buddhist|american|british|indian|pakistani|chinese|japanese|african|european|asian)\b/i,
    /\b(mother|father|parent|daughter|son|sister|brother|husband|wife|couple|coworker|colleague|friend)\b/i,
    /\b(doctor|teacher|engineer|driver|chef|student|employee|manager|performer|singer|athlete)\b/i,
    /\b(?:named|identified as|known as)\b/i,
    /\b\d{1,3}[- ]year[- ]old\b/i,
    /\b(?:in|at|from|near)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2}\b/,
  ];

  return patterns.some((pattern) => pattern.test(caption));
}

function matchedGroundingDetails(caption: string, brief: VisualBrief) {
  const captionTokens = new Set(contentWords(caption));

  return groundingDetails(brief).filter((detail) => {
    const detailTokens = contentWords(detail);
    return detailTokens.some((token) => captionTokens.has(token));
  });
}

function validateCaptions(captions: JudgeCaptions, brief: VisualBrief) {
  const issues: ValidationIssue[] = [];

  for (const key of captionKeys) {
    const caption = captions[key];
    const wordCount = words(caption).length;
    const sentenceEndings = caption.match(/[.!?](?:\s|$)/g)?.length || 0;

    if (wordCount < 15 || wordCount > 28 || caption.length > 200) {
      issues.push({
        code: "length_failure",
        message: `${key} must be 15-28 words and no more than 200 characters.`,
      });
    }

    if (sentenceEndings > 1) {
      issues.push({
        code: "style_mismatch",
        message: `${key} must contain exactly one sentence.`,
      });
    }

    if (matchedGroundingDetails(caption, brief).length < 2) {
      issues.push({
        code: "grounding_failure",
        message: `${key} must reuse at least two concrete details from the visual brief.`,
      });
    }

    if (unsupportedClaim(caption)) {
      issues.push({
        code: "unsupported_claim",
        message: `${key} contains an unsupported personal, audio, location, or emotion claim.`,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < captionKeys.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < captionKeys.length;
      rightIndex += 1
    ) {
      const leftKey = captionKeys[leftIndex];
      const rightKey = captionKeys[rightIndex];
      const left = captions[leftKey].toLowerCase();
      const right = captions[rightKey].toLowerCase();

      if (left === right || jaccardSimilarity(left, right) >= 0.58) {
        issues.push({
          code: "too_similar",
          message: `${leftKey} and ${rightKey} use wording that is too similar.`,
        });
      }
    }
  }

  if (
    /\b(lol|vibes?|plot twist|nailed it|obviously|apparently|joke|funny|lit|epic|flex|cringe|low-key)\b/i.test(
      captions.formal,
    )
  ) {
    issues.push({
      code: "style_mismatch",
      message: "formal must remain professional and contain no slang or jokes.",
    });
  }

  if (!hasSarcasticConstruction(captions.sarcastic)) {
    issues.push({
      code: "sarcasm_missing",
      message: "sarcastic needs a clear dry or ironic construction.",
    });
  }

  if (
    /\b(stupid|idiot|dumb|ugly|pathetic|loser|worthless|hate|disgusting|moron)\b/i.test(
      captions.sarcastic,
    )
  ) {
    issues.push({
      code: "style_mismatch",
      message: "sarcastic must not be cruel, insulting, or unsafe.",
    });
  }

  if (!containsTechnicalConcept(captions.humorous_tech)) {
    issues.push({
      code: "tech_missing",
      message: "humorous_tech must include a natural technology concept.",
    });
  }

  if (
    containsTechnicalConcept(captions.humorous_non_tech) ||
    /\b(ai|software|hardware|cache|compile|database|network)\b/i.test(
      captions.humorous_non_tech,
    ) ||
    !hasEverydayHumor(captions.humorous_non_tech)
  ) {
    issues.push({
      code: "style_mismatch",
      message:
        "humorous_non_tech must use everyday humor without technical vocabulary.",
    });
  }

  if (issues.length > 0) {
    throw new CaptionValidationError(issues);
  }
}

function cleanFallbackDetail(value: string) {
  return value
    .replace(/[.!?]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32)
    .toLowerCase();
}

function buildGroundedFallback(brief: VisualBrief): JudgeCaptions {
  const details = [...new Set(groundingDetails(brief).map(cleanFallbackDetail))]
    .filter(Boolean)
    .slice(0, 4);
  const first = details[0] || "clearly visible foreground details";
  const second = details[1] || "the surrounding background";
  const third = details[2] || first;
  const fourth = details[3] || second;

  return {
    formal: `The frames present ${first} alongside ${second}, creating a clear and professional visual record of the scene for careful review.`,
    sarcastic: `Apparently ${first} and ${third} arrived determined to make subtlety work overtime while staying plainly visible in the frame.`,
    humorous_tech: `The visual algorithm paired ${second} with ${fourth}, then completed deployment without requesting another update from the clearly visible scene.`,
    humorous_non_tech: `${first} and ${second} share the frame like two neighbors pretending this entire moment was completely planned from the start.`,
  };
}

function repairInvalidCaptions(
  captions: JudgeCaptions,
  brief: VisualBrief,
  issues: ValidationIssue[],
) {
  const fallback = buildGroundedFallback(brief);
  const affectedKeys = new Set<CaptionKey>();

  for (const issue of issues) {
    for (const key of captionKeys) {
      if (issue.message.includes(key)) {
        affectedKeys.add(key);
      }
    }
  }

  if (affectedKeys.size === 0) {
    return fallback;
  }

  return Object.fromEntries(
    captionKeys.map((key) => [
      key,
      affectedKeys.has(key) ? fallback[key] : captions[key],
    ]),
  ) as JudgeCaptions;
}

function visualBriefPrompt() {
  return `Inspect the five sampled video frames and return ONLY valid JSON with exactly this schema:
{
  "visible_objects": [],
  "visible_people": [],
  "clothing": [],
  "actions": [],
  "background": [],
  "readable_text": [],
  "scene_changes": [],
  "uncertain_details": []
}

Use compact noun or action phrases, not captions. Record only details clearly visible in the supplied frames.
Describe people neutrally as "person" or "people" and only record visually observable clothing or actions.
Do not infer identity, names, exact location, age, ethnicity, nationality, religion, occupation, relationships, emotion, intent, audio, speech, music, voice, weather, or hidden events.
Do not interpret unreadable text. Put genuinely ambiguous or contradictory visual observations in uncertain_details; otherwise return an empty array there.
Do not repeat the same detail across fields. No markdown, prose, or keys beyond the schema.`;
}

function visualVerificationPrompt(brief: VisualBrief) {
  return `Recheck the supplied frames only because the first visual brief contains uncertainty or contradiction.
Resolve uncertain items only when the frames clearly support a correction. Remove unsupported assumptions and return ONLY the same strict JSON schema.
Do not add identity, location, age, ethnicity, religion, occupation, relationships, emotion, audio, speech, music, or voice claims.

First brief:
${JSON.stringify(brief)}`;
}

function captionPrompt(brief: VisualBrief, retryIssues: ValidationIssue[] = []) {
  const retryInstruction = retryIssues.length
    ? `\nThis is the single correction attempt. Fix these validation failures:\n${retryIssues
        .map((issue) => `- ${issue.message}`)
        .join("\n")}`
    : "";

  return `Generate four captions using ONLY the verified visual brief below. Return ONLY valid JSON with exactly these keys:
{
  "formal": "...",
  "sarcastic": "...",
  "humorous_tech": "...",
  "humorous_non_tech": "..."
}

Rules for every caption:
- Exactly one sentence, around 15-28 words, and no more than 200 characters.
- Reuse at least two concrete nouns or action phrases from the brief so grounding can be verified locally.
- Do not use uncertain_details as evidence.
- Do not add audio, speech, music, voice, identity, names, exact location, age, ethnicity, nationality, religion, occupation, relationships, or emotions.
- Use noticeably different wording and a different angle for each style; do not merely swap an adjective.

Style rules:
- formal: professional and descriptive, with no slang, sarcasm, or jokes.
- sarcastic: dry or ironic but never cruel, insulting, or unsafe; naturally include a clear construction such as "apparently", "clearly", "of course", or "as if".
- humorous_tech: make a natural visual joke using at least one of algorithm, CPU, GPU, code, server, update, loading, deployment, bug, bandwidth, or debug.
- humorous_non_tech: use simple everyday humor with no technical vocabulary.

Verified visual brief:
${JSON.stringify(brief)}${retryInstruction}`;
}

async function visionCompletion(
  client: OpenAI,
  payload: CaptionRequestPayload,
  prompt: string,
) {
  const content: ChatCompletionContentPart[] = [
    { type: "text", text: prompt },
    ...payload.frames.slice(0, MAX_FRAMES).map(
      (frame): ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url: frame.dataUrl, detail: "low" },
      }),
    ),
  ];
  const completion = await client.chat.completions.create({
    model: JUDGE_VISION_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a conservative visual evidence extractor. Return strict JSON only.",
      },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    max_tokens: 700,
    temperature: 0.1,
  });
  const rawText = completion.choices[0]?.message.content?.trim();

  if (!rawText) {
    throw new Error("Fireworks Vision returned an empty visual brief.");
  }

  return normalizeBrief(rawText);
}

async function textCompletion(
  client: OpenAI,
  model: string,
  brief: VisualBrief,
  retryIssues: ValidationIssue[] = [],
) {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "Output the caption JSON immediately without analysis or task restatement. The first character must be { and the final character must be }.",
      },
      { role: "user", content: captionPrompt(brief, retryIssues) },
    ],
    response_format: { type: "json_object" },
    reasoning_effort: "none",
    max_tokens: 700,
    temperature: retryIssues.length > 0 ? 0.45 : 0.7,
  });
  const rawText = completion.choices[0]?.message.content?.trim();

  if (!rawText) {
    throw new CaptionValidationError([
      { code: "invalid_json", message: "Caption model returned no JSON." },
    ]);
  }

  if (process.env.NODE_ENV === "development") {
    console.log("Judge text model raw output:", rawText.slice(0, 1000));
  }

  return normalizeCaptions(rawText);
}

function retryableCaptionIssues(error: unknown) {
  if (!(error instanceof CaptionValidationError)) {
    return [];
  }

  const retryableCodes = new Set<ValidationCode>([
    "invalid_json",
    "too_similar",
    "tech_missing",
    "sarcasm_missing",
  ]);

  return error.issues.filter((issue) => retryableCodes.has(issue.code));
}

function logJudgeError(message: string, error: unknown) {
  console.error(message, {
    name: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  const validated = validatePayload(body);

  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const apiKey = process.env.FIREWORKS_API_KEY;

  if (!apiKey) {
    console.error("FIREWORKS_API_KEY is missing in the judge API environment.");
    return NextResponse.json(GENERIC_SAFE_CAPTIONS);
  }

  const textModel = process.env.FIREWORKS_TEXT_MODEL || DEFAULT_TEXT_MODEL;
  const visionClient = new OpenAI({
    apiKey,
    baseURL: FIREWORKS_BASE_URL,
    maxRetries: 0,
    timeout: VISION_CALL_TIMEOUT_MS,
  });
  const textClient = new OpenAI({
    apiKey,
    baseURL: FIREWORKS_BASE_URL,
    maxRetries: 0,
    timeout: TEXT_CALL_TIMEOUT_MS,
  });
  let brief: VisualBrief;

  try {
    brief = await visionCompletion(
      visionClient,
      validated.value,
      visualBriefPrompt(),
    );

    if (brief.uncertain_details.length > 0) {
      try {
        brief = await visionCompletion(
          visionClient,
          validated.value,
          visualVerificationPrompt(brief),
        );
      } catch (error) {
        logJudgeError(
          "Conditional visual brief verification failed; using the first grounded brief.",
          error,
        );
      }
    }
  } catch (error) {
    logJudgeError("Judge visual grounding failed.", error);
    return NextResponse.json(GENERIC_SAFE_CAPTIONS);
  }

  try {
    let captions: JudgeCaptions | null = null;

    try {
      captions = await textCompletion(textClient, textModel, brief);
      validateCaptions(captions, brief);
    } catch (firstError) {
      const retryIssues = retryableCaptionIssues(firstError);

      if (retryIssues.length === 0) {
        if (!(firstError instanceof CaptionValidationError) || !captions) {
          throw firstError;
        }

        captions = repairInvalidCaptions(
          captions,
          brief,
          firstError.issues,
        );
        validateCaptions(captions, brief);
      } else {
        captions = await textCompletion(
          textClient,
          textModel,
          brief,
          retryIssues,
        );

        try {
          validateCaptions(captions, brief);
        } catch (retryValidationError) {
          if (!(retryValidationError instanceof CaptionValidationError)) {
            throw retryValidationError;
          }

          captions = repairInvalidCaptions(
            captions,
            brief,
            retryValidationError.issues,
          );
          validateCaptions(captions, brief);
        }
      }
    }

    if (!captions) {
      throw new Error("Judge caption generation returned no captions.");
    }

    return NextResponse.json(captions);
  } catch (error) {
    logJudgeError("Judge caption generation failed local validation.", error);
    return NextResponse.json(buildGroundedFallback(brief));
  }
}
