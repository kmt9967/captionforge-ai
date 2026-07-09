# CaptionForge AI

CaptionForge AI is a hackathon-ready Next.js MVP for turning short video clips into four caption styles: formal, sarcastic, humorous-tech, and humorous-non-tech.

Built for the AMD Developer Hackathon Act II Track 2, the project demonstrates a Fireworks AI-ready captioning workflow with client-side video frame sampling, a secure server-side inference route, responsible fallback behavior, and human review before publishing.

## Features

- Upload a short local video and preview it in the browser.
- Add optional context or transcript text to guide caption generation.
- Extract up to five downsized preview frames with HTML video and canvas.
- Generate four social-media-ready caption styles.
- Use Fireworks Vision when the configured vision model is available.
- Fall back to Fireworks Text when the vision model is unavailable.
- Fall back to mock captions when Fireworks is unavailable, so the demo keeps moving.
- Copy any caption to the clipboard.
- Show visual summary and safety note cards alongside generated captions.
- Keep all API keys server-side through a Next.js API route.

## Tech Stack

- Next.js App Router
- TypeScript
- Tailwind CSS
- ESLint
- lucide-react
- OpenAI SDK with the Fireworks OpenAI-compatible endpoint
- Docker multi-stage production build

## Fireworks Vision Flow

The browser extracts five small JPEG preview frames from the uploaded video and stores them in React state as base64 data URLs. When the user clicks Generate Captions, the frontend sends those frames, optional context or transcript, the video filename, and the duration to `/api/captions`.

The API route validates the request, limits frame count and payload size, and calls Fireworks through the OpenAI-compatible SDK:

- `baseURL`: `https://api.fireworks.ai/inference/v1`
- `apiKey`: `FIREWORKS_API_KEY`
- vision model: `FIREWORKS_MODEL`

If the vision call succeeds, the UI labels the caption cards as `Fireworks Vision`.

## Fireworks Text Fallback

If the configured vision model returns an unavailable server status such as 404 or 500, the API route immediately tries the text fallback model from `FIREWORKS_TEXT_MODEL`.

The text fallback intentionally uses only:

- user-provided context or transcript
- video filename
- video duration

It does not pretend to analyze audio, pitch, voice, identity, hidden video details, or unavailable frames. If this fallback succeeds, the UI labels the result as `Fireworks Text` and shows the warning `Vision model unavailable: using Fireworks text fallback.`

If both Fireworks paths fail, CaptionForge AI returns safe mock captions and labels the cards as `Mock`.

## Responsible AI Notes

- Captions should be reviewed before publishing.
- AI may miss context, speech, sarcasm, or sensitive content.
- Users should not use captions to misrepresent people or events.
- The prototype uses uploaded video frames and optional user-provided context.
- The app avoids naming private people unless the user provides names in context.
- Technical limitations are kept in the visual summary and safety note, not inside the caption cards.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local environment file:

```powershell
Copy-Item .env.example .env.local
```

Add your Fireworks API key to `.env.local`, then start the dev server:

```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment Variables

```env
FIREWORKS_API_KEY=
FIREWORKS_MODEL=accounts/fireworks/models/minimax-m3
FIREWORKS_TEXT_MODEL=accounts/fireworks/models/deepseek-v4-pro
```

`.env.local` is ignored by git and should never be committed.

## Docker

Build the production image:

```bash
docker build -t captionforge-ai .
```

Run the app with runtime environment variables:

```bash
docker run --rm -p 3000:3000 --env-file .env.local captionforge-ai
```

Open `http://localhost:3000`.

Do not bake API keys into the image. Pass secrets at runtime with `--env-file` or your deployment platform's secret manager.

## Demo Workflow

1. Open the app.
2. Upload a 30 to 60 second video.
3. Add optional context or transcript.
4. Click `Extract Preview Frames`.
5. Confirm five thumbnails appear.
6. Click `Generate Captions`.
7. Review the source badge: `Fireworks Vision`, `Fireworks Text`, or `Mock`.
8. Read the visual summary and safety note.
9. Copy the best caption after human review.

## Useful Commands

```bash
npm run lint
npm run build
```
