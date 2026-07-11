"use client";

import Image from "next/image";
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Check,
  Clipboard,
  Copy,
  Cpu,
  FileVideo,
  Film,
  Flame,
  Layers3,
  MessageSquareText,
  Play,
  ScanLine,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import {
  ChangeEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  type CaptionApiErrorResponse,
  type CaptionApiResponse,
  CAPTION_FALLBACK_MESSAGE,
  FIREWORKS_MODEL_UNAVAILABLE_MESSAGE,
  type CaptionRequestPayload,
  type FireworksCaptionResponse,
} from "@/lib/caption-contract";

type CaptionStyle =
  | "Formal"
  | "Sarcastic"
  | "Humorous-tech"
  | "Humorous-non-tech";

type CaptionResult = {
  style: CaptionStyle;
  caption: string;
  accent: string;
  icon: ComponentType<{ className?: string }>;
};

type CaptionMode =
  | "idle"
  | "loading"
  | "fireworks-vision"
  | "fireworks-text"
  | "mock";

type CaptionMeta = {
  visualSummary: string;
  safetyNote: string;
};

type ExtractedFrame = {
  id: string;
  dataUrl: string;
  timestamp: number;
};

const architectureSteps = [
  {
    title: "Video Upload",
    description: "User selects a short clip and optional context.",
  },
  {
    title: "Frame Sampling",
    description: "Browser canvas captures representative preview frames.",
  },
  {
    title: "Fireworks AI Captioning",
    description: "Fireworks Vision reads sampled frames and user-provided context.",
  },
  {
    title: "Style Transformation",
    description: "One base caption becomes four audience-ready styles.",
  },
  {
    title: "Human Review",
    description: "Creator checks tone, accuracy, and sensitive context.",
  },
  {
    title: "Publish/Copy",
    description: "Approved captions are copied into the publishing workflow.",
  },
];

const responsibleNotes = [
  "Captions should be reviewed before publishing.",
  "AI may miss context, speech, sarcasm, or sensitive content.",
  "Users should not use captions to misrepresent people or events.",
  "The prototype uses uploaded video frames and optional user-provided context.",
];

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function waitForVideoEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };

    const handleEvent = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("The browser could not read this video."));
    };

    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

async function seekVideo(video: HTMLVideoElement, time: number) {
  const maxTime = Math.max(video.duration - 0.05, 0);
  const nextTime = Math.max(0, Math.min(time, maxTime));

  if (Math.abs(video.currentTime - nextTime) < 0.001) {
    return;
  }

  video.currentTime = nextTime;
  await waitForVideoEvent(video, "seeked");
}

function buildMockCaptions(context: string): CaptionResult[] {
  const trimmedContext = context.trim();
  const contextTail = trimmedContext
    ? ` Context hint: ${trimmedContext.slice(0, 120)}${
        trimmedContext.length > 120 ? "..." : ""
      }`
    : "";

  return [
    {
      style: "Formal",
      caption: `A concise short-form video highlights the key moment with clear context and a polished tone.${contextTail}`,
      accent: "border-red-400/50 bg-red-500/10 text-red-100",
      icon: BadgeCheck,
    },
    {
      style: "Sarcastic",
      caption:
        "Because obviously the internet was waiting for this exact clip, here is the caption with maximum confidence and minimum patience.",
      accent: "border-amber-300/50 bg-amber-400/10 text-amber-100",
      icon: Flame,
    },
    {
      style: "Humorous-tech",
      caption:
        "Five sampled frames walk into a model context window. The punchline ships after inference and a very dramatic loading spinner.",
      accent: "border-cyan-300/50 bg-cyan-400/10 text-cyan-100",
      icon: Cpu,
    },
    {
      style: "Humorous-non-tech",
      caption:
        "This clip has main character energy and politely requests a caption before it begins collecting suspicious amounts of attention.",
      accent: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
      icon: MessageSquareText,
    },
  ];
}

function buildIdleCaptions(): CaptionResult[] {
  return [
    {
      style: "Formal",
      caption: "Extract preview frames, then generate a polished caption.",
      accent: "border-red-400/50 bg-red-500/10 text-red-100",
      icon: BadgeCheck,
    },
    {
      style: "Sarcastic",
      caption: "Waiting for frames before the wit engine clocks in.",
      accent: "border-amber-300/50 bg-amber-400/10 text-amber-100",
      icon: Flame,
    },
    {
      style: "Humorous-tech",
      caption: "Frame tensors pending. Caption runtime not yet initialized.",
      accent: "border-cyan-300/50 bg-cyan-400/10 text-cyan-100",
      icon: Cpu,
    },
    {
      style: "Humorous-non-tech",
      caption: "Upload, sample, and this card gets much funnier.",
      accent: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
      icon: MessageSquareText,
    },
  ];
}

function buildLoadingCaptions(): CaptionResult[] {
  return [
    {
      style: "Formal",
      caption: "Analyzing sampled frames for a polished short caption...",
      accent: "border-red-400/50 bg-red-500/10 text-red-100",
      icon: BadgeCheck,
    },
    {
      style: "Sarcastic",
      caption: "Finding a witty angle without becoming needlessly mean...",
      accent: "border-amber-300/50 bg-amber-400/10 text-amber-100",
      icon: Flame,
    },
    {
      style: "Humorous-tech",
      caption: "Routing pixels through the caption pipeline...",
      accent: "border-cyan-300/50 bg-cyan-400/10 text-cyan-100",
      icon: Cpu,
    },
    {
      style: "Humorous-non-tech",
      caption: "Translating the moment into general-audience funny...",
      accent: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
      icon: MessageSquareText,
    },
  ];
}

function buildFireworksCaptions(
  response: FireworksCaptionResponse,
): CaptionResult[] {
  return [
    {
      style: "Formal",
      caption: response.formal,
      accent: "border-red-400/50 bg-red-500/10 text-red-100",
      icon: BadgeCheck,
    },
    {
      style: "Sarcastic",
      caption: response.sarcastic,
      accent: "border-amber-300/50 bg-amber-400/10 text-amber-100",
      icon: Flame,
    },
    {
      style: "Humorous-tech",
      caption: response.humorousTech,
      accent: "border-cyan-300/50 bg-cyan-400/10 text-cyan-100",
      icon: Cpu,
    },
    {
      style: "Humorous-non-tech",
      caption: response.humorousNonTech,
      accent: "border-emerald-300/50 bg-emerald-400/10 text-emerald-100",
      icon: MessageSquareText,
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCaptionApiResponse(value: unknown): value is CaptionApiResponse {
  if (!isRecord(value)) {
    return false;
  }

  const hasCaptions = [
    "formal",
    "sarcastic",
    "humorousTech",
    "humorousNonTech",
    "visualSummary",
    "safetyNote",
  ].every((key) => typeof value[key] === "string");

  return (
    hasCaptions &&
    (value.source === "fireworks-vision" ||
      value.source === "fireworks-text" ||
      value.source === "mock") &&
    (typeof value.warning === "undefined" || typeof value.warning === "string")
  );
}

function isCaptionApiErrorResponse(
  value: unknown,
): value is CaptionApiErrorResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.error === "string" &&
    (value.reason === "missing_api_key" ||
      value.reason === "model_unavailable" ||
      value.reason === "fireworks_unavailable")
  );
}

function getMockSafetyNote(error: CaptionApiErrorResponse | null) {
  if (error?.reason === "missing_api_key") {
    return "Review mock captions before publishing. Add FIREWORKS_API_KEY to .env.local for live generation.";
  }

  if (error?.reason === "model_unavailable") {
    return FIREWORKS_MODEL_UNAVAILABLE_MESSAGE;
  }

  return "Fireworks unavailable: using mock demo captions. Review mock captions before publishing.";
}

export function CaptionForgeApp() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoDuration, setVideoDuration] = useState<number | null>(null);
  const [context, setContext] = useState("");
  const [frames, setFrames] = useState<ExtractedFrame[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [frameError, setFrameError] = useState("");
  const [captions, setCaptions] = useState<CaptionResult[]>([]);
  const [captionMode, setCaptionMode] = useState<CaptionMode>("idle");
  const [captionMessage, setCaptionMessage] = useState("");
  const [captionMeta, setCaptionMeta] = useState<CaptionMeta>({
    visualSummary: "",
    safetyNote: "",
  });
  const [copiedStyle, setCopiedStyle] = useState<CaptionStyle | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const hasVideo = Boolean(selectedFile && videoUrl);
  const selectedFileSize = selectedFile ? formatFileSize(selectedFile.size) : "";

  const uploadSummary = useMemo(() => {
    if (!selectedFile) {
      return "Waiting for a short clip";
    }

    return `${selectedFile.name} - ${selectedFileSize}`;
  }, [selectedFile, selectedFileSize]);

  useEffect(() => {
    return () => {
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
      }
    };
  }, [videoUrl]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (videoUrl) {
      URL.revokeObjectURL(videoUrl);
    }

    setSelectedFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setVideoDuration(null);
    setFrames([]);
    setCaptions([]);
    setCaptionMode("idle");
    setCaptionMessage("");
    setCaptionMeta({ visualSummary: "", safetyNote: "" });
    setFrameError("");
    setCopiedStyle(null);
  }

  async function extractPreviewFrames() {
    if (!videoUrl) {
      setFrameError("Upload a video before extracting preview frames.");
      return;
    }

    setIsExtracting(true);
    setFrameError("");

    const video = document.createElement("video");
    const fileName = selectedFile?.name ?? "video";
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.src = videoUrl;
    video.load();

    try {
      if (video.readyState < 1) {
        await waitForVideoEvent(video, "loadedmetadata");
      }

      if (video.readyState < 2) {
        await waitForVideoEvent(video, "loadeddata");
      }

      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error("Could not determine the video duration.");
      }

      setVideoDuration(video.duration);

      const sourceWidth = video.videoWidth || 1280;
      const sourceHeight = video.videoHeight || 720;
      const scale = Math.min(1, 420 / sourceWidth);
      const canvas = document.createElement("canvas");
      const context2d = canvas.getContext("2d");

      if (!context2d) {
        throw new Error("Canvas rendering is unavailable in this browser.");
      }

      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));

      const frameCount = 5;
      const capturedFrames: ExtractedFrame[] = [];

      for (let index = 0; index < frameCount; index += 1) {
        const targetTime = (video.duration * (index + 1)) / (frameCount + 1);

        await seekVideo(video, targetTime);
        context2d.drawImage(video, 0, 0, canvas.width, canvas.height);

        capturedFrames.push({
          id: `${fileName}-${index}`,
          dataUrl: canvas.toDataURL("image/jpeg", 0.82),
          timestamp: video.currentTime,
        });
      }

      setFrames(capturedFrames);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Frame extraction failed. Try a different short clip.";
      setFrameError(message);
    } finally {
      video.removeAttribute("src");
      video.load();
      setIsExtracting(false);
    }
  }

  async function generateCaptions() {
    if (!selectedFile || frames.length === 0) {
      setCaptionMessage("Extract preview frames before generating captions.");
      return;
    }

    setIsGenerating(true);
    setCaptionMode("loading");
    setCaptionMessage("");
    setCaptionMeta({ visualSummary: "", safetyNote: "" });
    setCopiedStyle(null);

    const payload: CaptionRequestPayload = {
      frames: frames.slice(0, 5).map((frame) => ({
        dataUrl: frame.dataUrl,
        timestamp: frame.timestamp,
      })),
      context,
      videoFileName: selectedFile.name,
      videoDuration,
    };
    let fallbackError: CaptionApiErrorResponse | null = null;

    try {
      const response = await fetch("/api/captions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorBody: unknown = await response.json().catch(() => null);

        fallbackError = isCaptionApiErrorResponse(errorBody)
          ? errorBody
          : null;

        throw new Error(fallbackError?.error || CAPTION_FALLBACK_MESSAGE);
      }

      const data: unknown = await response.json();

      if (!isCaptionApiResponse(data)) {
        throw new Error("Caption API returned an invalid response.");
      }

      setCaptions(buildFireworksCaptions(data));
      setCaptionMeta({
        visualSummary: data.visualSummary,
        safetyNote: data.safetyNote,
      });
      setCaptionMode(data.source);
      setCaptionMessage(data.warning || "");
    } catch {
      setCaptions(buildMockCaptions(context));
      setCaptionMeta({
        visualSummary:
          "Demo fallback generated without a live Fireworks AI response.",
        safetyNote: getMockSafetyNote(fallbackError),
      });
      setCaptionMode("mock");
      setCaptionMessage(fallbackError?.error || CAPTION_FALLBACK_MESSAGE);
    } finally {
      setIsGenerating(false);
    }
  }

  async function copyCaption(result: CaptionResult) {
    try {
      await navigator.clipboard.writeText(result.caption);
      setCopiedStyle(result.style);
      window.setTimeout(() => setCopiedStyle(null), 1600);
    } catch {
      setCopiedStyle(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#08090c] text-zinc-100">
      <section className="border-b border-white/10 bg-[#0d0f14]">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.1fr_0.9fr] lg:px-8 lg:py-14">
          <div className="flex flex-col justify-center">
            <div className="mb-5 flex flex-wrap gap-2">
              <span className="rounded-full border border-red-400/30 bg-red-500/10 px-3 py-1 text-xs font-semibold text-red-100">
                AMD Developer Hackathon Act II
              </span>
              <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold text-zinc-200">
                Track 2
              </span>
              <span className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">
                Fireworks AI-ready prototype
              </span>
            </div>
            <h1 className="max-w-3xl text-5xl font-black leading-none text-white sm:text-6xl">
              CaptionForge AI
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-8 text-zinc-300 sm:text-xl">
              AI-powered multi-style video captioning for short clips.
            </p>
            <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-400">
              Built as an AMD Developer Hackathon Act II concept with a
              Fireworks AI-ready frontend flow: upload, sample frames, generate
              style variants, review, and copy.
            </p>
          </div>

          <div className="rounded-lg border border-red-500/25 bg-black/35 p-4 shadow-2xl shadow-red-950/20">
            <div className="flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <p className="text-sm font-semibold text-red-100">
                  Prototype Console
                </p>
                <p className="text-xs text-zinc-500">{uploadSummary}</p>
              </div>
              <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-red-400/30 bg-red-500/10">
                <Sparkles className="h-5 w-5 text-red-200" aria-hidden />
              </div>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-3 text-center text-xs text-zinc-400">
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <Film className="mx-auto mb-2 h-4 w-4 text-zinc-200" />
                Upload
              </div>
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <ScanLine className="mx-auto mb-2 h-4 w-4 text-zinc-200" />
                Sample
              </div>
              <div className="rounded-md border border-white/10 bg-white/[0.03] p-3">
                <Clipboard className="mx-auto mb-2 h-4 w-4 text-zinc-200" />
                Copy
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,0.78fr)]">
          <div className="rounded-lg border border-white/10 bg-zinc-950 p-5 shadow-xl shadow-black/30">
            <div className="flex flex-col gap-3 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase text-red-200">
                  Video Upload Panel
                </p>
                <h2 className="mt-1 text-2xl font-bold text-white">
                  Add a short clip
                </h2>
              </div>
              <button
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-red-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <UploadCloud className="h-4 w-4" aria-hidden />
                Select Video
              </button>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept="video/*"
                onChange={handleFileChange}
              />
            </div>

            <div className="mt-5 grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
              <div className="space-y-4">
                <label className="block text-sm font-semibold text-zinc-200">
                  Add context or transcript
                  <textarea
                    className="mt-2 min-h-36 w-full resize-y rounded-lg border border-white/10 bg-black/35 px-4 py-3 text-sm leading-6 text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-red-300 focus:ring-2 focus:ring-red-500/25"
                    placeholder="Paste speech, scene context, target audience, or anything the captions should understand."
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                  />
                </label>

                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <div className="flex items-start gap-3">
                    <FileVideo
                      className="mt-0.5 h-5 w-5 text-red-200"
                      aria-hidden
                    />
                    <div>
                      <p className="text-sm font-semibold text-white">
                        {selectedFile?.name ?? "No video selected"}
                      </p>
                      <p className="mt-1 text-sm text-zinc-400">
                        {selectedFile
                          ? `${selectedFileSize} - ${selectedFile.type || "video file"}`
                          : "Choose a local video file to preview and sample frames."}
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex min-h-72 items-center justify-center overflow-hidden rounded-lg border border-white/10 bg-black">
                {videoUrl ? (
                  <video
                    className="h-full max-h-[420px] w-full bg-black object-contain"
                    controls
                    onLoadedMetadata={(event) =>
                      setVideoDuration(event.currentTarget.duration)
                    }
                    playsInline
                    src={videoUrl}
                  />
                ) : (
                  <div className="flex flex-col items-center px-6 text-center text-zinc-500">
                    <Play
                      className="mb-4 h-12 w-12 text-zinc-700"
                      aria-hidden
                    />
                    <p className="text-sm font-medium text-zinc-400">
                      Video preview appears here
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <FrameExtractionPanel
            frames={frames}
            frameError={frameError}
            hasVideo={hasVideo}
            isExtracting={isExtracting}
            onExtract={() => void extractPreviewFrames()}
          />
        </section>

        <CaptionGeneratorPanel
          captionMessage={captionMessage}
          captionMeta={captionMeta}
          captionMode={captionMode}
          captions={captions}
          copiedStyle={copiedStyle}
          hasFrames={frames.length > 0}
          hasVideo={hasVideo}
          isGenerating={isGenerating}
          onCopy={(caption) => void copyCaption(caption)}
          onGenerate={() => void generateCaptions()}
        />

        <section className="mt-8 grid gap-6">
          <ResponsibleAiNotes />
          <ArchitectureSection />
        </section>
      </div>
    </main>
  );
}

function FrameExtractionPanel({
  frames,
  frameError,
  hasVideo,
  isExtracting,
  onExtract,
}: {
  frames: ExtractedFrame[];
  frameError: string;
  hasVideo: boolean;
  isExtracting: boolean;
  onExtract: () => void;
}) {
  return (
    <section className="rounded-lg border border-white/10 bg-zinc-950 p-5 shadow-xl shadow-black/30">
      <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-5">
        <div>
          <p className="text-sm font-semibold uppercase text-red-200">
            Frame Extraction Preview
          </p>
          <h2 className="mt-1 text-2xl font-bold text-white">
            Sample five frames
          </h2>
        </div>
        <button
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-red-400/40 bg-red-500/10 px-4 py-2 text-sm font-bold text-red-100 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-zinc-800 disabled:text-zinc-500"
          disabled={!hasVideo || isExtracting}
          onClick={onExtract}
          type="button"
        >
          <Layers3 className="h-4 w-4" aria-hidden />
          {isExtracting ? "Extracting..." : "Extract Preview Frames"}
        </button>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {frames.length > 0
          ? frames.map((frame, index) => (
              <div
                className="overflow-hidden rounded-lg border border-white/10 bg-black"
                key={frame.id}
              >
                <Image
                  className="aspect-video w-full object-cover"
                  src={frame.dataUrl}
                  alt={`Extracted preview frame ${index + 1}`}
                  width={420}
                  height={236}
                  unoptimized
                />
                <div className="flex items-center justify-between px-3 py-2 text-xs text-zinc-400">
                  <span>Frame {index + 1}</span>
                  <span>{frame.timestamp.toFixed(1)}s</span>
                </div>
              </div>
            ))
          : Array.from({ length: 5 }).map((_, index) => (
              <div
                className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-white/10 bg-white/[0.03] text-xs text-zinc-600"
                key={index}
              >
                Frame {index + 1}
              </div>
            ))}
      </div>

      {frameError ? (
        <p className="mt-4 rounded-md border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          {frameError}
        </p>
      ) : (
        <p className="mt-4 text-sm leading-6 text-zinc-500">
          Base64 image data is stored in browser state for the future Fireworks
          AI captioning step.
        </p>
      )}
    </section>
  );
}

function CaptionGeneratorPanel({
  captionMessage,
  captionMeta,
  captionMode,
  captions,
  copiedStyle,
  hasFrames,
  hasVideo,
  isGenerating,
  onCopy,
  onGenerate,
}: {
  captionMessage: string;
  captionMeta: CaptionMeta;
  captionMode: CaptionMode;
  captions: CaptionResult[];
  copiedStyle: CaptionStyle | null;
  hasFrames: boolean;
  hasVideo: boolean;
  isGenerating: boolean;
  onCopy: (caption: CaptionResult) => void;
  onGenerate: () => void;
}) {
  const captionsToShow = isGenerating
    ? buildLoadingCaptions()
    : captions.length > 0
      ? captions
      : buildIdleCaptions();
  const badgeText =
    captionMode === "fireworks-vision"
      ? "Fireworks Vision"
      : captionMode === "fireworks-text"
        ? "Fireworks Text"
      : captionMode === "mock"
        ? "Mock"
        : isGenerating
          ? "Generating"
          : "Waiting";
  const canCopy =
    captionMode === "fireworks-vision" ||
    captionMode === "fireworks-text" ||
    captionMode === "mock";
  const visualSummary = isGenerating
    ? "Analyzing sampled frames and optional context..."
    : captionMeta.visualSummary ||
      "Visual summary appears after captions are generated.";
  const safetyNote = isGenerating
    ? "Checking captions against safe public-posting guidance..."
    : captionMeta.safetyNote ||
      "Safety note appears after captions are generated.";

  return (
    <section className="mt-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase text-red-200">
            Caption Generator Panel
          </p>
          <h2 className="mt-1 text-3xl font-bold text-white">
            Four caption styles
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            Fireworks AI reads the sampled frames through a secure API route.
            Extract frames first; fallback mock captions keep the demo moving
            when the API is unavailable.
          </p>
        </div>

        <button
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-white px-5 py-3 text-sm font-black text-zinc-950 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          disabled={!hasVideo || !hasFrames || isGenerating}
          onClick={onGenerate}
          type="button"
        >
          <Sparkles className="h-4 w-4" aria-hidden />
          {isGenerating ? "Generating..." : "Generate Captions"}
        </button>
      </div>

      {captionMessage ? (
        <p className="mt-4 rounded-md border border-amber-300/30 bg-amber-400/10 px-3 py-2 text-sm leading-6 text-amber-100">
          {captionMessage}
        </p>
      ) : null}

      <div className="mt-5 grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {captionsToShow.map((result) => {
          const Icon = result.icon;
          const isCopied = copiedStyle === result.style;

          return (
            <article
              className={`flex min-h-72 min-w-0 flex-col rounded-lg border p-5 ${result.accent}`}
              key={result.style}
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0" aria-hidden />
                  <h3 className="min-w-0 break-words text-base font-black">
                    {result.style}
                  </h3>
                </div>
                <span className="shrink-0 rounded-full border border-current/25 px-2.5 py-1 text-xs font-bold">
                  {badgeText}
                </span>
              </div>

              <p
                className={`mt-5 flex-1 break-words text-sm leading-6 text-zinc-100 ${
                  isGenerating ? "animate-pulse" : ""
                }`}
              >
                {result.caption}
              </p>

              <button
                className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-current/25 bg-black/25 px-4 py-2 text-sm font-bold transition hover:bg-black/40 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!canCopy || isGenerating}
                onClick={() => onCopy(result)}
                type="button"
              >
                {isCopied ? (
                  <Check className="h-4 w-4" aria-hidden />
                ) : (
                  <Copy className="h-4 w-4" aria-hidden />
                )}
                {isCopied ? "Copied" : "Copy Caption"}
              </button>
            </article>
          );
        })}
      </div>

      <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-2">
        <CaptionInsightCard
          icon={ScanLine}
          isLoading={isGenerating}
          title="Visual summary"
          value={visualSummary}
        />
        <CaptionInsightCard
          icon={AlertTriangle}
          isLoading={isGenerating}
          title="Safety note"
          value={safetyNote}
        />
      </div>
    </section>
  );
}

function CaptionInsightCard({
  icon: Icon,
  isLoading,
  title,
  value,
}: {
  icon: ComponentType<{ className?: string }>;
  isLoading: boolean;
  title: string;
  value: string;
}) {
  return (
    <article className="min-w-0 rounded-lg border border-white/10 bg-zinc-950 p-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-400/25 bg-red-500/10">
          <Icon className="h-5 w-5 text-red-100" aria-hidden />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-black uppercase text-red-100">{title}</h3>
          <p
            className={`mt-2 break-words text-sm leading-6 text-zinc-300 ${
              isLoading ? "animate-pulse" : ""
            }`}
          >
            {value}
          </p>
        </div>
      </div>
    </article>
  );
}

function ResponsibleAiNotes() {
  return (
    <section className="rounded-lg border border-white/10 bg-zinc-950 p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-amber-300/30 bg-amber-400/10">
          <AlertTriangle className="h-5 w-5 text-amber-100" aria-hidden />
        </div>
        <div>
          <p className="text-sm font-semibold uppercase text-red-200">
            Responsible AI Notes
          </p>
          <h2 className="text-2xl font-bold text-white">Review before publish</h2>
        </div>
      </div>

      <ul className="mt-5 space-y-3">
        {responsibleNotes.map((note) => (
          <li className="flex gap-3 text-sm leading-6 text-zinc-300" key={note}>
            <Check
              className="mt-1 h-4 w-4 shrink-0 text-emerald-200"
              aria-hidden
            />
            <span>{note}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ArchitectureSection() {
  return (
    <section
      className="overflow-hidden rounded-lg border border-white/10 bg-zinc-950 p-5"
      data-testid="architecture-section"
    >
      <div>
        <p className="text-sm font-semibold uppercase text-red-200">
          Architecture
        </p>
        <h2 className="mt-1 text-2xl font-bold text-white">
          Caption pipeline
        </h2>
      </div>

      <div
        className="mt-5 grid min-w-0 grid-cols-1 gap-3 xl:grid-cols-3 xl:gap-x-10 xl:gap-y-5"
        data-testid="architecture-grid"
      >
        {architectureSteps.map((step, index) => (
          <div className="relative min-w-0" key={step.title}>
            <div
              className="group relative h-full min-w-0 rounded-lg border border-white/10 bg-white/[0.03] p-4 transition hover:border-red-300/35 hover:bg-red-500/[0.06] xl:p-5"
              data-testid="architecture-step"
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-red-400/30 bg-red-500/10 text-sm font-black text-red-100">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <h3 className="whitespace-normal break-words text-base font-black leading-6 text-white">
                    {step.title}
                  </h3>
                  <p className="mt-2 whitespace-normal break-words text-sm leading-6 text-zinc-400">
                    {step.description}
                  </p>
                </div>
              </div>
            </div>

            {index < architectureSteps.length - 1 && index !== 2 ? (
              <div
                className="pointer-events-none absolute -right-8 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-red-400/30 bg-zinc-950 text-red-200 shadow-lg shadow-black/30 xl:flex"
                aria-hidden
              >
                <ArrowRight className="h-4 w-4" />
              </div>
            ) : null}

            {index < architectureSteps.length - 1 ? (
              <div className="flex justify-center py-1 text-red-200 xl:hidden">
                <ArrowRight className="h-5 w-5 rotate-90" aria-hidden />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
