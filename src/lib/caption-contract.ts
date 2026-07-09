export const CAPTION_FALLBACK_MESSAGE =
  "Fireworks unavailable: using mock demo captions";

export const FIREWORKS_TEXT_FALLBACK_MESSAGE =
  "Vision model unavailable: using Fireworks text fallback.";

export const FIREWORKS_MODEL_UNAVAILABLE_MESSAGE =
  "Selected Fireworks model is unavailable for this workspace. Showing mock captions.";

export type CaptionFallbackReason =
  | "missing_api_key"
  | "model_unavailable"
  | "fireworks_unavailable";

export type CaptionSource = "fireworks-vision" | "fireworks-text" | "mock";

export type CaptionRequestFrame = {
  dataUrl: string;
  timestamp: number;
};

export type CaptionRequestPayload = {
  frames: CaptionRequestFrame[];
  context?: string;
  videoFileName?: string;
  videoDuration?: number | null;
};

export type FireworksCaptionResponse = {
  formal: string;
  sarcastic: string;
  humorousTech: string;
  humorousNonTech: string;
  visualSummary: string;
  safetyNote: string;
};

export type CaptionApiResponse = FireworksCaptionResponse & {
  source: CaptionSource;
  warning?: string;
};

export type CaptionApiErrorResponse = {
  error: string;
  reason: CaptionFallbackReason;
};
