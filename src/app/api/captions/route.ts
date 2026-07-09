import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { NextResponse } from "next/server";
import {
  CAPTION_FALLBACK_MESSAGE,
  FIREWORKS_MODEL_UNAVAILABLE_MESSAGE,
  FIREWORKS_TEXT_FALLBACK_MESSAGE,
  type CaptionApiResponse,
  type CaptionRequestFrame,
  type CaptionRequestPayload,
  type FireworksCaptionResponse,
} from "@/lib/caption-contract";

export const runtime = "nodejs";

const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const DEFAULT_FIREWORKS_VISION_MODEL =
  "accounts/fireworks/models/minimax-m3";
const DEFAULT_FIREWORKS_TEXT_MODEL =
  "accounts/fireworks/models/deepseek-v4-pro";
const MAX_FRAMES = 5;
const MAX_FRAME_CHARS = 800_000;
const MAX_TOTAL_FRAME_CHARS = 2_500_000;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_FILE_NAME_CHARS = 180;

const requiredResponseKeys = [
  "formal",
  "sarcastic",
  "humorousTech",
  "humorousNonTech",
  "visualSummary",
  "safetyNote",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedDataImage(value: string) {
  return /^data:image\/(?:jpeg|jpg|png|webp);base64,[a-z0-9+/=]+$/i.test(
    value,
  );
}

function readFrame(value: unknown): CaptionRequestFrame | null {
  if (typeof value === "string") {
    return {
      dataUrl: value.trim(),
      timestamp: 0,
    };
  }

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

  return {
    dataUrl,
    timestamp,
  };
}

function validatePayload(payload: unknown):
  | { ok: true; value: CaptionRequestPayload }
  | { ok: false; error: string } {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be a JSON object." };
  }

  const rawFrames = payload.frames;

  if (!Array.isArray(rawFrames) || rawFrames.length === 0) {
    return { ok: false, error: "At least one extracted frame is required." };
  }

  if (rawFrames.length > MAX_FRAMES) {
    return { ok: false, error: `Send ${MAX_FRAMES} frames or fewer.` };
  }

  const frames = rawFrames.map(readFrame);

  if (frames.some((frame) => frame === null)) {
    return {
      ok: false,
      error: "Frames must include base64 image data and timestamps.",
    };
  }

  const normalizedFrames = frames as CaptionRequestFrame[];

  if (normalizedFrames.some((frame) => !isSupportedDataImage(frame.dataUrl))) {
    return {
      ok: false,
      error: "Frames must be base64 image data URLs.",
    };
  }

  if (normalizedFrames.some((frame) => frame.dataUrl.length > MAX_FRAME_CHARS)) {
    return {
      ok: false,
      error: "One or more frames are too large. Downsize before sending.",
    };
  }

  const totalFrameChars = normalizedFrames.reduce(
    (total, frame) => total + frame.dataUrl.length,
    0,
  );

  if (totalFrameChars > MAX_TOTAL_FRAME_CHARS) {
    return {
      ok: false,
      error: "Frame payload is too large. Send smaller sampled frames.",
    };
  }

  const context =
    typeof payload.context === "string"
      ? payload.context.trim().slice(0, MAX_CONTEXT_CHARS)
      : "";

  const videoFileName =
    typeof payload.videoFileName === "string"
      ? payload.videoFileName.trim().slice(0, MAX_FILE_NAME_CHARS)
      : "uploaded-video";

  const videoDuration =
    typeof payload.videoDuration === "number" &&
    Number.isFinite(payload.videoDuration) &&
    payload.videoDuration > 0
      ? Math.round(payload.videoDuration * 10) / 10
      : null;

  return {
    ok: true,
    value: {
      frames: normalizedFrames,
      context,
      videoFileName,
      videoDuration,
    },
  };
}

function stripCodeFences(rawText: string) {
  return rawText
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
}

function normalizeCaptionKey(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readStringField(value: Record<string, unknown>, aliases: string[]) {
  const aliasSet = new Set(aliases.map(normalizeCaptionKey));

  for (const [key, field] of Object.entries(value)) {
    if (aliasSet.has(normalizeCaptionKey(key)) && typeof field === "string") {
      const trimmed = field.trim();

      if (trimmed) {
        return trimmed;
      }
    }
  }

  return "";
}

function normalizeCaptionResponse(value: unknown): FireworksCaptionResponse {
  if (!isRecord(value)) {
    throw new Error("Model JSON response must be an object.");
  }

  const response: FireworksCaptionResponse = {
    formal: readStringField(value, ["formal"]),
    sarcastic: readStringField(value, ["sarcastic"]),
    humorousTech: readStringField(value, [
      "humorousTech",
      "humorous_tech",
      "humorous-tech",
      "humorous tech",
      "techHumor",
      "tech_humor",
    ]),
    humorousNonTech: readStringField(value, [
      "humorousNonTech",
      "humorous_non_tech",
      "humorous-non-tech",
      "humorous non tech",
      "generalHumor",
      "general_humor",
      "nonTechHumor",
    ]),
    visualSummary: readStringField(value, [
      "visualSummary",
      "visual_summary",
      "visual-summary",
      "summary",
    ]),
    safetyNote: readStringField(value, [
      "safetyNote",
      "safety_note",
      "safety-note",
      "safety",
    ]),
  };

  for (const key of requiredResponseKeys) {
    if (!response[key]) {
      throw new Error(`Model JSON response is missing ${key}.`);
    }
  }

  return sanitizeCaptionResponse(response);
}

function sanitizeCaptionText(text: string) {
  const metaPatterns = [
    /\bwe are asked to generate captions?\b/gi,
    /\bbased on (the )?(provided )?(context|transcript)\b[:,]?\s*/gi,
    /\bbased on (the )?(visible )?frames?\b[:,]?\s*/gi,
    /\bbased on (the )?limited context\b[:,]?\s*/gi,
    /\blimited context\b[:,]?\s*/gi,
    /\bfilename\b[:,]?\s*/gi,
    /\bvideo file ?name\b[:,]?\s*/gi,
    /\bfile ?name\b[:,]?\s*/gi,
    /\bframe timestamps?\b[:,]?\s*/gi,
    /\bvision model (is )?unavailable\b[:,]?\s*/gi,
    /\bFireworks\b[:,]?\s*/gi,
    /\bAI[- ]?generated\b[:,]?\s*/gi,
    /\bthe model\b[:,]?\s*/gi,
    /\bthe prompt\b[:,]?\s*/gi,
    /\bas an AI\b[:,]?\s*/gi,
    /\bthe task is to\b[:,]?\s*/gi,
    /\bI was asked to\b[:,]?\s*/gi,
  ];

  const withoutMeta = metaPatterns.reduce(
    (current, pattern) => current.replace(pattern, ""),
    text,
  );
  const normalized = withoutMeta
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/^[-:;,\s]+/, "")
    .trim();

  if (!normalized) {
    return "A short, share-ready moment with room for your final review.";
  }

  const sentences = normalized
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");

  return sentences.length > 180
    ? `${sentences.slice(0, 177).trim()}...`
    : sentences;
}

function sanitizeCaptionResponse(
  response: FireworksCaptionResponse,
): FireworksCaptionResponse {
  return {
    formal: sanitizeCaptionText(response.formal),
    sarcastic: sanitizeCaptionText(response.sarcastic),
    humorousTech: sanitizeCaptionText(response.humorousTech),
    humorousNonTech: sanitizeCaptionText(response.humorousNonTech),
    visualSummary: response.visualSummary.trim(),
    safetyNote: response.safetyNote.trim(),
  };
}

function parseCaptionResponse(rawText: string): FireworksCaptionResponse | null {
  const withoutFence = stripCodeFences(rawText);
  const startIndexes: number[] = [];
  const endIndexes: number[] = [];

  for (let index = 0; index < withoutFence.length; index += 1) {
    if (withoutFence[index] === "{") {
      startIndexes.push(index);
    }

    if (withoutFence[index] === "}") {
      endIndexes.push(index);
    }
  }

  for (const startIndex of startIndexes) {
    for (const endIndex of endIndexes) {
      if (endIndex <= startIndex) {
        continue;
      }

      try {
        const parsed = JSON.parse(withoutFence.slice(startIndex, endIndex + 1));
        return normalizeCaptionResponse(parsed);
      } catch {
        // Keep scanning for a smaller valid JSON object inside model prose.
      }
    }
  }

  return null;
}

function cleanRawModelText(rawText: string) {
  return stripCodeFences(rawText)
    .replace(/\s+/g, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
}

function firstUsefulSentence(rawText: string) {
  const cleaned = cleanRawModelText(rawText);
  const [firstSentence] = cleaned.split(/(?<=[.!?])\s+/);
  const usable = firstSentence || cleaned || "Caption generated from text context.";

  return usable.length > 180 ? `${usable.slice(0, 177).trim()}...` : usable;
}

function contextSubject(payload: CaptionRequestPayload) {
  if (payload.context) {
    return payload.context.slice(0, 80).trim();
  }

  if (payload.videoFileName) {
    return payload.videoFileName;
  }

  return "this short clip";
}

function buildTextCaptionsFromRawResponse({
  payload,
  rawText,
}: {
  payload: CaptionRequestPayload;
  rawText: string;
}): FireworksCaptionResponse {
  const subject = contextSubject(payload);

  return sanitizeCaptionResponse({
    formal: firstUsefulSentence(rawText),
    sarcastic: `Sure, because ${subject} clearly needed a caption with dramatic timing.`,
    humorousTech:
      "Caption engine warmed up, drama skipped, share button ready.",
    humorousNonTech: `${subject} brought the moment; the backup caption brought the punchline.`,
    visualSummary:
      "Generated from user-provided context because the vision model is unavailable for this workspace.",
    safetyNote:
      "Generated from user-provided context because the vision model is unavailable for this workspace. Review captions before publishing.",
  });
}

function describeVideo({
  context,
  frames,
  videoDuration,
  videoFileName,
}: CaptionRequestPayload) {
  const frameTimestamps = frames
    .map((frame, index) => `Frame ${index + 1}: ${frame.timestamp.toFixed(1)}s`)
    .join(", ");

  return `Video file name: ${videoFileName || "uploaded-video"}
Video duration: ${videoDuration ? `${videoDuration}s` : "not provided"}
Sampled frame timestamps: ${frameTimestamps || "not provided"}
Optional context/transcript:
${context || "No extra context provided."}`;
}

function describeTextFallbackInput({
  context,
  videoDuration,
  videoFileName,
}: CaptionRequestPayload) {
  return `Video file name: ${videoFileName || "uploaded-video"}
Video duration: ${videoDuration ? `${videoDuration}s` : "not provided"}
Optional context/transcript:
${context || "No extra context provided."}`;
}

function captionRules() {
  return `Return ONLY valid JSON. No markdown. No explanation. No code fence.

Use exactly this JSON schema:
{
  "formal": "...",
  "sarcastic": "...",
  "humorousTech": "...",
  "humorousNonTech": "...",
  "visualSummary": "...",
  "safetyNote": "..."
}

Caption rules:
- Each caption should be short and social-media-ready.
- Caption fields must contain final caption copy only, with no task explanation.
- Captions must not include these phrases or ideas: "we are asked", "based on the context", "based on the frames", "limited context", "filename", "frame timestamps", "vision model unavailable", "Fireworks", "AI generated", "the model", "the prompt", "as an AI", or any explanation of the task.
- Keep technical limitations only in visualSummary and safetyNote, not in formal, sarcastic, humorousTech, or humorousNonTech.
- Each caption should be 1-2 short sentences max.
- Formal: polished and professional.
- Sarcastic: witty but not offensive or cruel.
- Humorous-tech: funny using technology/dev/AI language without claiming fake audio/video analysis.
- Humorous-non-tech: funny for a general audience.
- Do not invent facts not visible in the frames or provided context.
- If evidence is unclear, keep captions generic and put limitations only in visualSummary or safetyNote.
- Do not identify private people by name unless the user provided names in context.
- Do not say you analyzed audio, pitch, voice, identity, or hidden video details unless explicitly provided in the context.
- Do not claim emotion detection, identity recognition, speech analysis, or confidence scores unless explicitly provided in the context.
- Avoid hateful, sexual, violent, or harmful content.
- Keep captions safe for public posting.`;
}

function createVisionPrompt(payload: CaptionRequestPayload) {
  return `Analyze only the sampled video frames and user-provided context/transcript, then generate catchy short-video captions.

Vision-specific rules:
- Use visible scene/action details, clothing, pose, performance style, setting, and on-screen text only when clearly visible.
- You may describe visible clothing or scene details, such as "wearing a hijab" or "wearing a headscarf", when relevant and clearly visible in the frames.
- Do not infer religion, ethnicity, nationality, age, identity, beliefs, background, or personal details unless the user explicitly provides them in the context/transcript.
- You may say "woman wearing a hijab" only if clearly visible. Do not say "Muslim woman" unless the user explicitly provides that.
- Do not guess age, ethnicity, nationality, religion, personal identity, or background.
- If audio/transcript is not provided, do not claim to understand lyrics, speech, pitch, tone, or voice.
- Avoid saying "based on the context", "based on the frames", "the model sees", "AI generated", "Fireworks", or any task/meta language inside caption fields.
- Captions should be engaging and natural, not robotic.
- visualSummary should honestly summarize visible scene/action and provided context only.
- safetyNote should remind the user to review captions and avoid misrepresenting people, events, or context.

${describeVideo(payload)}

${captionRules()}`;
}

function createTextFallbackPrompt(payload: CaptionRequestPayload) {
  return `The vision model is unavailable for this workspace. Generate captions only from:
- user-provided context/transcript
- video filename
- video duration

You cannot see video frames in this fallback path. Do not pretend you analyzed frames, previews, audio, voice, pitch, hidden content, identities, emotions, or visual details.
Do not say you analyzed audio, pitch, voice, identity, or hidden video details unless explicitly provided in the context.
Do not claim emotion detection, identity recognition, speech analysis, audio analysis, pitch detection, or confidence scores.
The four caption fields must be clean, short, social-media-ready captions only.
Do not put meta or prompt language in the four captions. Forbidden caption wording includes: "we are asked", "based on the context", "based on the frames", "limited context", "filename", "frame timestamps", "vision model unavailable", "Fireworks", "AI generated", "the model", "the prompt", "as an AI", and any explanation of this task.
Put technical limitations only in visualSummary and safetyNote.
Keep humorous-tech funny but honest, for example: "Caption engine warmed up, drama skipped, share button ready."
Set visualSummary to: "Generated from user-provided context because the vision model is unavailable for this workspace."
Set safetyNote to: "Generated from user-provided context because the vision model is unavailable for this workspace. Review captions before publishing."
If the available context is thin, keep the captions generic and natural without saying "limited context".

${describeTextFallbackInput(payload)}

${captionRules()}`;
}

function getErrorStatus(error: unknown) {
  if (!isRecord(error)) {
    return undefined;
  }

  return typeof error.status === "number" ? error.status : undefined;
}

function shouldTryTextFallback(error: unknown) {
  const status = getErrorStatus(error);

  return status === 404 || status === 500;
}

function logCaptionError(message: string, error?: unknown) {
  if (error instanceof Error) {
    console.error(message, {
      name: error.name,
      message: error.message,
      status: getErrorStatus(error),
    });
    return;
  }

  console.error(message, error);
}

function buildMockCaptionResponse({
  payload,
  warning,
}: {
  payload: CaptionRequestPayload;
  warning: string;
}): CaptionApiResponse {
  const contextHint = payload.context
    ? ` Based on provided context: ${payload.context.slice(0, 120)}${
        payload.context.length > 120 ? "..." : ""
      }`
    : " Based on limited context from the upload metadata.";

  return {
    formal: `A concise short-form clip is ready for review.${contextHint}`,
    sarcastic:
      "The model took a coffee break, so this demo caption is doing its best.",
    humorousTech:
      "Fallback mode compiled successfully: captions generated without the vision stack.",
    humorousNonTech:
      "The video brought the vibes; the backup caption brought the backup plan.",
    visualSummary:
      "Mock fallback generated without a successful Fireworks model response.",
    safetyNote: warning,
    source: "mock",
    warning,
  };
}

async function createCaptionCompletionText({
  client,
  content,
  model,
}: {
  client: OpenAI;
  content: string | ChatCompletionContentPart[];
  model: string;
}) {
  const completion = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You are CaptionForge AI, a careful short-video captioning assistant. Return safe, concise JSON only.",
      },
      {
        role: "user",
        content,
      },
    ],
    response_format: { type: "json_object" },
    max_tokens: 700,
    temperature: 0.7,
  });

  const message = completion.choices[0]?.message.content?.trim();

  if (!message) {
    throw new Error("Fireworks returned an empty caption response.");
  }

  return message;
}

async function createCaptionCompletion({
  client,
  content,
  model,
}: {
  client: OpenAI;
  content: string | ChatCompletionContentPart[];
  model: string;
}) {
  const rawText = await createCaptionCompletionText({
    client,
    content,
    model,
  });
  const parsed = parseCaptionResponse(rawText);

  if (!parsed) {
    throw new Error("Model response did not include a JSON object.");
  }

  return parsed;
}

function logRawModelOutput(label: string, rawText: string) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  console.log(label, rawText.slice(0, 1000));
}

async function generateVisionCaptions({
  client,
  model,
  payload,
}: {
  client: OpenAI;
  model: string;
  payload: CaptionRequestPayload;
}) {
  const content: ChatCompletionContentPart[] = [
    {
      type: "text",
      text: createVisionPrompt(payload),
    },
    ...payload.frames.slice(0, MAX_FRAMES).map(
      (frame): ChatCompletionContentPart => ({
        type: "image_url",
        image_url: {
          url: frame.dataUrl,
          detail: "low",
        },
      }),
    ),
  ];

  return createCaptionCompletion({
    client,
    content,
    model,
  });
}

async function generateTextFallbackCaptions({
  client,
  model,
  payload,
}: {
  client: OpenAI;
  model: string;
  payload: CaptionRequestPayload;
}) {
  const rawText = await createCaptionCompletionText({
    client,
    content: createTextFallbackPrompt(payload),
    model,
  });

  logRawModelOutput("Fireworks text fallback raw output:", rawText);

  return (
    parseCaptionResponse(rawText) ||
    buildTextCaptionsFromRawResponse({
      payload,
      rawText,
    })
  );
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

  const visionModel =
    process.env.FIREWORKS_MODEL || DEFAULT_FIREWORKS_VISION_MODEL;
  const textModel =
    process.env.FIREWORKS_TEXT_MODEL || DEFAULT_FIREWORKS_TEXT_MODEL;
  const apiKey = process.env.FIREWORKS_API_KEY;

  if (!apiKey) {
    logCaptionError("FIREWORKS_API_KEY is missing; using mock fallback.");
    return NextResponse.json(
      buildMockCaptionResponse({
        payload: validated.value,
        warning: CAPTION_FALLBACK_MESSAGE,
      }),
    );
  }

  const client = new OpenAI({
    apiKey,
    baseURL: FIREWORKS_BASE_URL,
  });

  try {
    console.log("Using Fireworks vision model:", visionModel);

    const captions = await generateVisionCaptions({
      client,
      model: visionModel,
      payload: validated.value,
    });

    const response: CaptionApiResponse = {
      ...captions,
      source: "fireworks-vision",
    };

    return NextResponse.json(response);
  } catch (visionError) {
    if (!shouldTryTextFallback(visionError)) {
      logCaptionError(
        `Fireworks vision caption generation failed for model ${visionModel}.`,
        visionError,
      );

      return NextResponse.json(
        buildMockCaptionResponse({
          payload: validated.value,
          warning: CAPTION_FALLBACK_MESSAGE,
        }),
      );
    }

    logCaptionError(
      `Fireworks vision model failed for model ${visionModel}; trying text fallback.`,
      visionError,
    );
  }

  try {
    console.log("Using Fireworks text fallback model:", textModel);

    const captions = await generateTextFallbackCaptions({
      client,
      model: textModel,
      payload: validated.value,
    });

    const response: CaptionApiResponse = {
      ...captions,
      source: "fireworks-text",
      warning: FIREWORKS_TEXT_FALLBACK_MESSAGE,
    };

    return NextResponse.json(response);
  } catch (textError) {
    logCaptionError(
      `Fireworks text fallback failed for model ${textModel}.`,
      textError,
    );

    const isModelUnavailable = getErrorStatus(textError) === 404;

    return NextResponse.json(
      buildMockCaptionResponse({
        payload: validated.value,
        warning: isModelUnavailable
          ? FIREWORKS_MODEL_UNAVAILABLE_MESSAGE
          : CAPTION_FALLBACK_MESSAGE,
      }),
    );
  }
}
