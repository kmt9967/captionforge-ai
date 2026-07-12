import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";

const INPUT_PATH = "/input/tasks.json";
const OUTPUT_DIRECTORY = "/output";
const OUTPUT_TEMP_PATH = join(OUTPUT_DIRECTORY, "results.tmp.json");
const OUTPUT_PATH = join(OUTPUT_DIRECTORY, "results.json");
const CAPTION_API_URL =
  "https://captionforge-ai-omega.vercel.app/api/captions";

const MAX_CONCURRENT_TASKS = 2;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_TIMEOUT_MS = 45_000;
const CAPTION_API_TIMEOUT_MS = 30_000;
const MAX_FRAME_DATA_URL_CHARS = 790_000;
const MAX_TOTAL_FRAME_CHARS = 2_450_000;
const FRAME_POSITIONS = [0.1, 0.3, 0.5, 0.7, 0.9];
const SUPPORTED_STYLES = [
  "formal",
  "sarcastic",
  "humorous_tech",
  "humorous_non_tech",
];
const SUPPORTED_STYLE_SET = new Set(SUPPORTED_STYLES);
const API_RESPONSE_KEYS = {
  formal: "formal",
  sarcastic: "sarcastic",
  humorous_tech: "humorousTech",
  humorous_non_tech: "humorousNonTech",
};
const SAFE_FALLBACK_CAPTIONS = {
  formal:
    "Caption generation was unavailable; please review this video before publishing.",
  sarcastic:
    "The caption service missed its cue, so human review gets the spotlight.",
  humorous_tech:
    "The caption pipeline timed out gracefully; manual review is now the most reliable feature.",
  humorous_non_tech:
    "The automatic caption took a break, so this clip is waiting for a human touch.",
};
const FRAME_PROFILES = [
  { width: 640, quality: 5 },
  { width: 560, quality: 7 },
  { width: 480, quality: 9 },
  { width: 400, quality: 12 },
  { width: 320, quality: 16 },
  { width: 256, quality: 20 },
];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createTimeoutController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();

  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

async function runCommand(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-20_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || `terminated by ${signal || "unknown"}`;
        reject(new Error(`${command} exited with code ${code}: ${detail}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function normalizeVideoFileName(videoUrl) {
  const url = new URL(videoUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("video_url must use HTTP or HTTPS.");
  }

  let decodedName = "clip.mp4";

  try {
    decodedName = decodeURIComponent(basename(url.pathname)) || "clip.mp4";
  } catch {
    decodedName = basename(url.pathname) || "clip.mp4";
  }

  const safeName = decodedName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180);
  return safeName || "clip.mp4";
}

async function downloadVideo(videoUrl, destination) {
  const timeout = createTimeoutController(DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(videoUrl, {
      redirect: "follow",
      signal: timeout.signal,
    });

    if (!response.ok) {
      throw new Error(`Video download failed with HTTP ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("Video download returned an empty response body.");
    }

    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(destination, { flags: "wx" }),
    );
  } catch (error) {
    if (timeout.signal.aborted) {
      throw new Error(`Video download timed out after ${DOWNLOAD_TIMEOUT_MS}ms.`);
    }

    throw error;
  } finally {
    timeout.clear();
  }
}

async function probeDuration(videoPath) {
  const { stdout } = await runCommand(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ],
    FFPROBE_TIMEOUT_MS,
  );
  const duration = Number.parseFloat(stdout.trim());

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("ffprobe did not return a valid positive duration.");
  }

  return duration;
}

async function extractFrame({
  framePath,
  quality,
  timestamp,
  videoPath,
  width,
}) {
  await runCommand(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      timestamp.toFixed(3),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      `scale='min(${width},iw)':-2`,
      "-q:v",
      String(quality),
      framePath,
    ],
    FFMPEG_TIMEOUT_MS,
  );
}

async function readFramesAsDataUrls(framePaths, timestamps) {
  const dataUrls = await Promise.all(
    framePaths.map(async (framePath, index) => {
      const image = await readFile(framePath);
      return {
        dataUrl: `data:image/jpeg;base64,${image.toString("base64")}`,
        timestamp: Math.round(timestamps[index] * 10) / 10,
      };
    }),
  );
  const totalChars = dataUrls.reduce(
    (total, frame) => total + frame.dataUrl.length,
    0,
  );
  const framesFit = dataUrls.every(
    (frame) => frame.dataUrl.length <= MAX_FRAME_DATA_URL_CHARS,
  );

  return { dataUrls, framesFit, totalChars };
}

async function extractRepresentativeFrames(videoPath, tempDirectory, duration) {
  const timestamps = FRAME_POSITIONS.map((position) => duration * position);
  const framePaths = FRAME_POSITIONS.map((_, index) =>
    join(tempDirectory, `frame-${index + 1}.jpg`),
  );

  for (const profile of FRAME_PROFILES) {
    await Promise.all(
      framePaths.map((framePath) => rm(framePath, { force: true })),
    );

    for (let index = 0; index < framePaths.length; index += 1) {
      await extractFrame({
        framePath: framePaths[index],
        quality: profile.quality,
        timestamp: timestamps[index],
        videoPath,
        width: profile.width,
      });
    }

    const encoded = await readFramesAsDataUrls(framePaths, timestamps);

    if (encoded.framesFit && encoded.totalChars < MAX_TOTAL_FRAME_CHARS) {
      return encoded.dataUrls;
    }
  }

  throw new Error("Five compressed frames could not fit within the API limits.");
}

function requestedStyles(task) {
  if (!task || typeof task !== "object" || !Array.isArray(task.styles)) {
    return [];
  }

  return [...new Set(task.styles.filter((style) => SUPPORTED_STYLE_SET.has(style)))];
}

function validateTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Task must be a JSON object.");
  }

  if (typeof task.task_id !== "string" || !task.task_id.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }

  if (typeof task.video_url !== "string" || !task.video_url.trim()) {
    throw new Error("video_url must be a non-empty string.");
  }

  if (!Array.isArray(task.styles) || task.styles.length === 0) {
    throw new Error("styles must be a non-empty array.");
  }

  const unsupportedStyles = task.styles.filter(
    (style) => !SUPPORTED_STYLE_SET.has(style),
  );

  if (unsupportedStyles.length > 0) {
    throw new Error(`Unsupported caption style: ${String(unsupportedStyles[0])}`);
  }

  return {
    taskId: task.task_id,
    videoUrl: task.video_url,
    styles: [...new Set(task.styles)],
  };
}

function selectCaptions(styles, captions) {
  return Object.fromEntries(styles.map((style) => [style, captions[style]]));
}

function mapApiCaptions(styles, response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Caption API returned an invalid JSON object.");
  }

  const captions = {};

  for (const style of styles) {
    const responseKey = API_RESPONSE_KEYS[style];
    const caption = response[responseKey];

    if (typeof caption !== "string" || !caption.trim()) {
      throw new Error(`Caption API response is missing ${responseKey}.`);
    }

    captions[style] = caption.trim();
  }

  return captions;
}

async function requestCaptions(payload, styles) {
  const requestBody = JSON.stringify(payload);
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const timeout = createTimeoutController(CAPTION_API_TIMEOUT_MS);

    try {
      const response = await fetch(CAPTION_API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: timeout.signal,
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `Caption API returned HTTP ${response.status}: ${responseText.slice(0, 300)}`,
        );
      }

      let responseBody;

      try {
        responseBody = JSON.parse(responseText);
      } catch {
        throw new Error("Caption API returned invalid JSON.");
      }

      return mapApiCaptions(styles, responseBody);
    } catch (error) {
      lastError = timeout.signal.aborted
        ? new Error(`Caption API timed out after ${CAPTION_API_TIMEOUT_MS}ms.`)
        : error;

      if (attempt === 1) {
        console.warn(`Caption API attempt 1 failed; retrying once: ${errorMessage(lastError)}`);
      }
    } finally {
      timeout.clear();
    }
  }

  throw lastError || new Error("Caption API failed after one retry.");
}

async function processTask(rawTask, index) {
  const preservedTaskId =
    rawTask && typeof rawTask === "object" && "task_id" in rawTask
      ? rawTask.task_id
      : `task-${index + 1}`;
  const fallbackStyles = requestedStyles(rawTask);
  let tempDirectory;

  try {
    const task = validateTask(rawTask);
    const videoFileName = normalizeVideoFileName(task.videoUrl);
    tempDirectory = await mkdtemp(join(tmpdir(), "captionforge-judge-"));
    const videoExtension = extname(videoFileName) || ".mp4";
    const videoPath = join(tempDirectory, `video${videoExtension}`);

    console.log(`[${task.taskId}] Downloading video.`);
    await downloadVideo(task.videoUrl, videoPath);

    const duration = await probeDuration(videoPath);
    const frames = await extractRepresentativeFrames(
      videoPath,
      tempDirectory,
      duration,
    );
    const captions = await requestCaptions(
      {
        frames,
        context: "",
        videoFileName,
        videoDuration: Math.round(duration * 10) / 10,
      },
      task.styles,
    );

    console.log(`[${task.taskId}] Completed.`);
    return { task_id: task.taskId, captions };
  } catch (error) {
    console.error(`[${String(preservedTaskId)}] Task failed: ${errorMessage(error)}`);
    return {
      task_id: preservedTaskId,
      captions: selectCaptions(fallbackStyles, SAFE_FALLBACK_CAPTIONS),
    };
  } finally {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true }).catch((error) => {
        console.warn(`Temporary file cleanup failed: ${errorMessage(error)}`);
      });
    }
  }
}

async function processTasks(tasks) {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await processTask(tasks[index], index);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENT_TASKS, tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function main() {
  let tasks;

  try {
    const rawInput = await readFile(INPUT_PATH, "utf8");
    tasks = JSON.parse(rawInput);

    if (!Array.isArray(tasks)) {
      throw new Error("/input/tasks.json must contain a JSON array.");
    }
  } catch (error) {
    throw new Error(`Unable to read tasks: ${errorMessage(error)}`);
  }

  try {
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  } catch (error) {
    throw new Error(`Unable to create output directory: ${errorMessage(error)}`);
  }

  const results = await processTasks(tasks);

  try {
    await writeFile(OUTPUT_TEMP_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    await rename(OUTPUT_TEMP_PATH, OUTPUT_PATH);
  } catch (error) {
    throw new Error(`Unable to write results: ${errorMessage(error)}`);
  }

  console.log(`Wrote ${results.length} result(s) to ${OUTPUT_PATH}.`);
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
