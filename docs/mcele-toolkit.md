# MCeLE toolkit

These local TypeScript adapters support authenticated catalog search, playlists, media resolution and download, course inspection, and document retrieval. They use the web application's existing requests and pages, so changes to that application can require adapter updates. This is a prototype, not an official supported API.

## Setup

Use Node 24 or newer and `npm ci` (including development dependencies). Browser commands require Google Chrome; video inspection requires `ffprobe`, and clip preparation also requires `ffmpeg` on your PATH.

1. Copy `.env.example` to `.env` if you do not already have one. Set `MCELE_USERNAME` and `MCELE_PASSWORD` there.
2. Copy `mcele.config.example.json` to `.runtime/mcele/config.json`, creating the directory if needed. Replace every placeholder using connection details supplied privately by your deployment operator. Real hosts and endpoint paths are deliberately absent from the repository. The `.invalid` example hosts are rejected before use.
3. Run `npm run mcele -- login --headed`. Accept any required consent or interactive sign-in step yourself in Chrome. Subsequent commands reuse the saved session; repeat login when it expires.

If `COACH_DATA_DIR` is set, configuration, session state, and downloads live in its `mcele/` subdirectory instead. Keep that directory outside version control. The CLI loads `.env`; callers importing the modules directly must load their environment first.

The private configuration has four HTTPS origins (`portal`, `media`, `learning`, `content`) and root-relative route templates. Keep each template's named placeholders, such as `{courseId}` or `{shortId}`, in the appropriate path or query position. `mediaPrefix` and `coursePrefix` are directory paths ending in `/`. `signIn` is the sign-in pathname suffix; consent and player entries are exact pathnames. Do not put passwords, cookies, or signed launch tokens in this configuration.

## Commands

These examples contain placeholders, not real content IDs:

```sh
npm run mcele -- search media "maintenance" 1
npm run mcele -- search courses "maintenance" 1
npm run mcele -- search documents "maintenance" 1
npm run mcele -- find "maintenance"
npm run mcele -- playlist <playlist-uuid> 1
npm run mcele -- resolve <media-short-id>
npm run mcele -- download <media-short-id>
npm run mcele -- prepare <media-short-id> 0 60
npm run mcele -- course <course-uuid-or-learning-platform-id>
npm run mcele -- course-package <course-uuid>
npm run mcele -- course-videos <course-uuid>
npm run mcele -- document <document-short-id-or-uuid>
npm run mcele -- folder <folder-id>
```

Commands print JSON. Media short IDs have 12 hexadecimal characters. Course/package and playlist IDs use UUIDs; learning-platform and folder IDs are numeric. Catalog search is paginated. `find` expands up to three playlists from the first result page and reports whether more results exist.

`course` reads course descriptions and access status. `course-package` opens an already available course launch, which can record ordinary LMS access. It does not enroll, submit assessments, or bypass prerequisites. Cached package metadata avoids repeat launches; add `--refresh` to refresh it. `course-videos` downloads available MP4 references from supported Captivate models; this is not a general offline exporter for every course format. Standard package paths, DOM selectors, and response field names remain in source because the adapters depend on them.

`download` keeps the original MP4 and audio. `prepare` creates a 320×180 H.264/AAC clip, with a maximum requested duration of 300 seconds. Library commands accept PDF, DOCX, PPTX, and ZIP content. Downloads enforce format and size checks. Media and course-video responses are buffered before their size checks, so this toolkit is intended for a single trusted local operator rather than a public download service.

## Private data

`.env`, `.runtime/`, `output/`, browser captures, and local investigation notes are excluded from Git. Saved sessions and downloads belong to one account; remove its session and cached files before switching accounts. Real command output can include source URLs, content metadata, and local paths. Keep it out of public issues, logs, fixtures, and documentation.

Only retrieve material your account is authorized to access. Preserve content markings and do not treat account access or visibility flags as permission to redistribute course content. No downloaded course files, sample account responses, enrollment records, or live connection profile are included here.

## Code map

- `scripts/mcele.ts` dispatches CLI commands and sanitizes error output.
- `server/src/mcele-config.ts` validates the private profile and builds URLs with encoded parameters.
- `server/src/mcele-session.ts` manages login, saved sessions, downloads, and video preparation.
- `server/src/mcele.ts` handles catalog search, playlists, and media metadata.
- `server/src/mcele-courses.ts` inspects course descriptions and access status.
- `server/src/mcele-course-package.ts` inspects supported package metadata and downloads referenced videos.
- `server/src/mcele-library.ts` downloads supported library files and folders.

For application integration, import these functions into a trusted local/backend process. Keep credentials and session cookies out of browser and glasses client bundles.
