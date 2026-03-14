import { type NextRequest, NextResponse } from "next/server";

/**
 * GET /api/captions?v={videoId}
 *
 * Fetches YouTube captions server-side to avoid CORS issues.
 * Returns available caption tracks + cues for a requested track.
 *
 * Query params:
 *   v       - YouTube video ID (required)
 *   lang    - Language code to fetch cues for (optional, returns track list if omitted)
 */

interface InnerTubeTrack {
  baseUrl?: string;
  name?: { simpleText?: string; runs?: { text: string }[] };
  languageCode?: string;
  kind?: string;
  vssId?: string;
}

interface CaptionCueRaw {
  start: number;
  duration: number;
  end: number;
  text: string;
}

/** Public Invidious instances for fallback when YouTube blocks cloud IPs */
const INVIDIOUS_INSTANCES = ["inv.nadeko.net", "yewtu.be", "invidious.nerdvpn.de"];

/** Piped API instances for additional fallback (proxies caption content through own servers) */
const PIPED_INSTANCES = [
  "pipedapi.kavin.rocks",
  "pipedapi.adminforge.de",
  "pipedapi-libre.kavin.rocks",
  "api.piped.yt",
  "piapi.ggtyler.dev",
  "pipedapi.darkness.services",
  "pipedapi.reallyaweso.me",
  "pipedapi.leptons.xyz",
];

/** Number of Piped instances to race concurrently (subset of PIPED_INSTANCES) */
const PIPED_RACE_SIZE = 4;

/** Fisher-Yates shuffle (returns new array) */
function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Consent cookies to bypass YouTube's GDPR consent page on EU/serverless IPs */
const YT_CONSENT_COOKIES = "CONSENT=PENDING+999; SOCS=CAESEwgDEgk2ODE3MTY1NzQaAmVuIAEaBgiA_LyuBg";

/** Map Invidious label names → ISO 639-1 codes (Invidious sometimes omits language_code) */
const LANG_LABEL_TO_CODE: Record<string, string> = {
  English: "en",
  Korean: "ko",
  Japanese: "ja",
  Chinese: "zh",
  "Chinese (Simplified)": "zh-Hans",
  "Chinese (Traditional)": "zh-Hant",
  Spanish: "es",
  French: "fr",
  German: "de",
  Portuguese: "pt",
  Russian: "ru",
  Italian: "it",
  Arabic: "ar",
  Hindi: "hi",
  Thai: "th",
  Vietnamese: "vi",
  Indonesian: "id",
  Turkish: "tr",
  Dutch: "nl",
  Polish: "pl",
  Swedish: "sv",
  Norwegian: "no",
  Danish: "da",
  Finnish: "fi",
  Czech: "cs",
  Romanian: "ro",
  Hungarian: "hu",
  Greek: "el",
  Hebrew: "he",
  Malay: "ms",
  Filipino: "fil",
  Ukrainian: "uk",
};

/** Reverse map: ISO code → English label (for Invidious label= queries) */
const LANG_CODE_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_LABEL_TO_CODE).map(([label, code]) => [code, label]),
);

/** Extract ISO language code from Invidious label (e.g. "Korean (auto-generated)" → "ko") */
function langCodeFromLabel(label: string): string | undefined {
  // Try exact match first, then strip parenthetical suffix
  return LANG_LABEL_TO_CODE[label] ?? LANG_LABEL_TO_CODE[label.replace(/\s*\(.*\)$/, "")];
}

/** Global deadline for entire GET handler (Vercel Hobby 10s function limit) */
const VERCEL_DEADLINE_MS = 9000;

/** Feature flags: disable broken third-party fallbacks (all instances currently down) */
const ENABLE_PIPED_FALLBACK = false;
const ENABLE_INVIDIOUS_FALLBACK = false;

/** Fetch with AbortController timeout (safe for Vercel Hobby 10s limit) */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractVideoId(input: string): string | null {
  // Already a plain ID (11 chars)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  try {
    const url = new URL(input);
    // youtube.com/watch?v=xxx
    if (url.searchParams.has("v")) return url.searchParams.get("v");
    // youtu.be/xxx
    if (url.hostname === "youtu.be") {
      const id = url.pathname.slice(1).split("/")[0];
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    // youtube.com/embed/xxx or /shorts/xxx
    const match = url.pathname.match(/\/(embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
    if (match) return match[2];
  } catch {
    // Not a URL
  }
  return null;
}

/** Extract language code from InnerTube vssId (e.g. "a.en" → "en", ".ko" → "ko") */
function extractLangFromVssId(vssId: string | undefined): string | undefined {
  if (!vssId) return undefined;
  const match = vssId.match(/^a?\.(.+)$/);
  return match?.[1] ?? undefined;
}

/** Check if track is auto-generated based on vssId prefix ("a." = auto) */
function isAutoFromVssId(vssId: string | undefined): boolean {
  return vssId?.startsWith("a.") ?? false;
}

function extractTrackName(track: InnerTubeTrack): string {
  return (
    track.name?.simpleText ??
    track.name?.runs?.[0]?.text ??
    track.languageCode ??
    extractLangFromVssId(track.vssId) ??
    "Unknown"
  );
}

/** Map InnerTube tracks to app format, applying vssId fallbacks and filtering invalid tracks */
function mapAndFilterTracks(tracks: InnerTubeTrack[]) {
  return tracks
    .map((t) => {
      let langCode = t.languageCode;
      let isAuto = t.kind === "asr";

      if (!langCode) {
        const fromVss = extractLangFromVssId(t.vssId);
        if (fromVss) {
          console.warn(
            `[captions] languageCode missing, using vssId fallback: "${t.vssId}" → "${fromVss}"`,
          );
          langCode = fromVss;
        }
      }

      if (t.kind === undefined && t.vssId) {
        isAuto = isAutoFromVssId(t.vssId);
      }

      return {
        languageCode: langCode,
        name: extractTrackName(t),
        isAutoGenerated: isAuto,
        baseUrl: t.baseUrl,
      };
    })
    .filter(
      (t): t is typeof t & { languageCode: string; baseUrl: string } =>
        !!t.languageCode && !!t.baseUrl,
    );
}

/** Primary: extract caption data from YouTube watch page HTML */
async function fetchFromWatchPage(videoId: string, remainingMs: () => number = () => 9000) {
  const res = await fetchWithTimeout(
    `https://www.youtube.com/watch?v=${videoId}&hl=en`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: YT_CONSENT_COOKIES,
      },
    },
    Math.min(4000, remainingMs()),
  );

  if (!res.ok) {
    throw new Error(`Watch page fetch failed: ${res.status}`);
  }

  const html = await res.text();

  const marker = "var ytInitialPlayerResponse = ";
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) {
    throw new Error("Could not find ytInitialPlayerResponse in watch page");
  }

  const jsonStart = startIdx + marker.length;
  let depth = 0;
  let endIdx = jsonStart;
  for (; endIdx < html.length; endIdx++) {
    if (html[endIdx] === "{") depth++;
    else if (html[endIdx] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }

  const data = JSON.parse(html.substring(jsonStart, endIdx + 1));

  const videoDetails = data.videoDetails ?? {};
  const title = videoDetails.title ?? "Unknown";
  const channelName = videoDetails.author ?? "Unknown";

  const renderer = data.captions?.playerCaptionsTracklistRenderer;
  const tracks: InnerTubeTrack[] = renderer?.captionTracks ?? [];

  return {
    videoId,
    title,
    channelName,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    captionTracks: mapAndFilterTracks(tracks),
  };
}

/**
 * InnerTube client configurations for fallback chain.
 * IOS/ANDROID clients return caption track URLs without POT (exp=xpe) requirement,
 * so the timedtext cue fetching works reliably. WEB/MWEB clients and watch page
 * scraping now return URLs that require POT tokens (empty responses from timedtext API).
 * Order: IOS (most reliable for captions) → ANDROID → WEB (fallback for metadata)
 */
const INNERTUBE_CLIENTS = [
  {
    label: "IOS",
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "20.03.02",
        hl: "en",
        gl: "US",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "18.2.1.22C161",
      },
    },
    userAgent: "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
  },
  {
    label: "ANDROID",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.03.02",
        hl: "en",
        gl: "US",
        androidSdkVersion: 35,
        osName: "Android",
        osVersion: "15",
      },
    },
    userAgent: "com.google.android.youtube/20.03.02 (Linux; U; Android 15) gzip",
  },
  {
    label: "WEB",
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20241126.01.00",
        hl: "en",
        gl: "US",
      },
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  },
] as const;

/** Try fetching caption tracks with a specific InnerTube client */
async function tryFetchWithClient(
  videoId: string,
  client: (typeof INNERTUBE_CLIENTS)[number],
  remainingMs: () => number = () => 9000,
) {
  const res = await fetchWithTimeout(
    "https://www.youtube.com/youtubei/v1/player",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": client.userAgent,
        Cookie: YT_CONSENT_COOKIES,
      },
      body: JSON.stringify({
        videoId,
        context: client.context,
      }),
    },
    Math.min(3000, remainingMs()),
  );

  if (!res.ok) {
    throw new Error(`InnerTube API failed (${client.label}): ${res.status}`);
  }

  const data = await res.json();

  const videoDetails = data.videoDetails ?? {};
  const title = videoDetails.title ?? "Unknown";
  const channelName = videoDetails.author ?? "Unknown";

  const renderer = data.captions?.playerCaptionsTracklistRenderer;
  const tracks: InnerTubeTrack[] = renderer?.captionTracks ?? [];

  return {
    videoId,
    title,
    channelName,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    captionTracks: mapAndFilterTracks(tracks),
  };
}

/** Fallback: fetch title/channel from YouTube oEmbed (not affected by consent) */
async function fetchOEmbedMeta(
  videoId: string,
): Promise<{ title: string; channelName: string } | null> {
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      {},
      3000,
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title ?? "Unknown",
      channelName: data.author_name ?? "Unknown",
    };
  } catch {
    return null;
  }
}

/** Parse WebVTT text into CaptionCueRaw[] */
function parseWebVTT(vtt: string): CaptionCueRaw[] {
  const cues: CaptionCueRaw[] = [];
  const lines = vtt.split(/\r?\n/);
  let i = 0;

  // Skip header (WEBVTT and any metadata lines)
  while (i < lines.length && !lines[i].includes("-->")) {
    i++;
  }

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(
      /(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})/,
    );
    if (!match) {
      // Also handle MM:SS.mmm format (no hours)
      const shortMatch = line.match(/(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2})\.(\d{3})/);
      if (shortMatch) {
        const start =
          Number(shortMatch[1]) * 60 + Number(shortMatch[2]) + Number(shortMatch[3]) / 1000;
        const end =
          Number(shortMatch[4]) * 60 + Number(shortMatch[5]) + Number(shortMatch[6]) / 1000;
        i++;
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== "") {
          textLines.push(lines[i].trim());
          i++;
        }
        const text = textLines
          .join(" ")
          .replace(/<[^>]+>/g, "")
          .trim();
        if (text) {
          cues.push({ start, duration: end - start, end, text });
        }
      } else {
        i++;
      }
      continue;
    }

    const start =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
    const end =
      Number(match[5]) * 3600 + Number(match[6]) * 60 + Number(match[7]) + Number(match[8]) / 1000;
    i++;

    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "") {
      textLines.push(lines[i].trim());
      i++;
    }
    const text = textLines
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (text) {
      cues.push({ start, duration: end - start, end, text });
    }
  }

  return cues;
}

/** Fetch caption tracks from Invidious API (bypasses YouTube cloud IP blocks) */
async function fetchTracksFromInvidious(videoId: string) {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetchWithTimeout(
        `https://${instance}/api/v1/captions/${videoId}`,
        {
          headers: {
            Accept: "application/json",
          },
        },
        4000,
      );

      if (!res.ok) continue;

      const data = await res.json();
      const captions: { label: string; language_code: string; url: string }[] =
        data.captions ?? data;

      if (!Array.isArray(captions) || captions.length === 0) continue;

      // Fetch video title from Invidious video endpoint
      let title = "Unknown";
      let channelName = "Unknown";
      try {
        const videoRes = await fetchWithTimeout(
          `https://${instance}/api/v1/videos/${videoId}?fields=title,author`,
          { headers: { Accept: "application/json" } },
          3000,
        );
        if (videoRes.ok) {
          const videoData = await videoRes.json();
          title = videoData.title ?? title;
          channelName = videoData.author ?? channelName;
        }
      } catch {
        // Use defaults
      }

      console.log(
        `[captions] invidious (${instance}): found ${captions.length} track(s) for ${videoId}`,
      );

      const captionTracks = captions
        .map((c) => {
          let langCode = c.language_code;
          if (!langCode) {
            const fromLabel = langCodeFromLabel(c.label);
            if (fromLabel) {
              console.warn(
                `[captions] invidious: language_code missing for "${c.label}", mapped to "${fromLabel}"`,
              );
              langCode = fromLabel;
            } else {
              console.warn(
                `[captions] invidious: language_code missing for "${c.label}", using label as fallback`,
              );
              langCode = c.label;
            }
          }
          return {
            languageCode: langCode,
            name: c.label,
            isAutoGenerated: c.label.toLowerCase().includes("auto"),
            baseUrl: c.url.startsWith("http") ? c.url : `https://${instance}${c.url}`,
          };
        })
        .filter((t) => !!t.languageCode && !!t.baseUrl);

      return {
        videoId,
        title,
        channelName,
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        captionTracks,
        _invidiousInstance: instance,
      };
    } catch (err) {
      console.warn(
        `[captions] invidious (${instance}) failed for ${videoId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return null;
}

/** Fetch caption cues from Invidious WebVTT endpoint */
async function fetchCuesFromInvidious(
  videoId: string,
  lang: string,
): Promise<CaptionCueRaw[] | null> {
  const isLangCode = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang);
  // Build query strategies: try lang= first, then label= as fallback
  const queries: string[] = [];
  if (isLangCode) {
    queries.push(`lang=${encodeURIComponent(lang)}`);
    const labelName = LANG_CODE_TO_LABEL[lang];
    if (labelName) queries.push(`label=${encodeURIComponent(labelName)}`);
  } else {
    queries.push(`label=${encodeURIComponent(lang)}`);
  }

  for (const instance of INVIDIOUS_INSTANCES) {
    for (const query of queries) {
      try {
        const res = await fetchWithTimeout(
          `https://${instance}/api/v1/captions/${videoId}?${query}`,
          {},
          4000,
        );
        if (!res.ok) continue;

        const vtt = await res.text();
        if (!vtt || !vtt.includes("-->")) continue;

        const cues = parseWebVTT(vtt);
        if (cues.length > 0) {
          console.log(
            `[captions] invidious cues (${instance}, ${query}): got ${cues.length} cue(s) for ${videoId}/${lang}`,
          );
          return cues;
        }
      } catch (err) {
        console.warn(
          `[captions] invidious cues (${instance}, ${query}) failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
  return null;
}

/** Fetch caption tracks from a single Piped instance (used by parallel racer) */
async function fetchTracksFromPipedInstance(videoId: string, instance: string) {
  const res = await fetchWithTimeout(
    `https://${instance}/streams/${videoId}`,
    { headers: { Accept: "application/json" } },
    5000,
  );
  if (!res.ok) throw new Error(`Piped ${instance}: HTTP ${res.status}`);

  const data = await res.json();
  const subtitles: { url?: string; mimeType?: string; name?: string; code?: string }[] =
    data.subtitles;
  if (!Array.isArray(subtitles) || subtitles.length === 0) {
    throw new Error(`Piped ${instance}: no subtitles`);
  }

  const captionTracks = subtitles
    .filter((s): s is typeof s & { code: string; url: string } => !!s.code && !!s.url)
    .map((s) => ({
      languageCode: s.code,
      name: s.name ?? s.code,
      isAutoGenerated: s.name?.toLowerCase().includes("auto") ?? false,
      baseUrl: s.url,
    }));

  if (captionTracks.length === 0) throw new Error(`Piped ${instance}: 0 valid tracks`);

  console.log(
    `[captions] piped (${instance}): found ${captionTracks.length} track(s) for ${videoId}`,
  );

  return {
    videoId,
    title: (data.title as string) ?? "Unknown",
    channelName: (data.uploader as string) ?? "Unknown",
    thumbnailUrl:
      (data.thumbnailUrl as string) ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    captionTracks,
    _pipedInstance: instance,
  };
}

/** Fetch caption tracks from Piped API (races PIPED_RACE_SIZE random instances in parallel) */
async function fetchTracksFromPiped(videoId: string) {
  const candidates = shuffle(PIPED_INSTANCES).slice(0, PIPED_RACE_SIZE);
  try {
    return await Promise.any(candidates.map((inst) => fetchTracksFromPipedInstance(videoId, inst)));
  } catch (err) {
    if (err instanceof AggregateError) {
      for (const e of err.errors) {
        console.warn(`[captions] piped track race: ${e instanceof Error ? e.message : e}`);
      }
    }
    return null;
  }
}

/** Fetch caption cues from a single Piped instance (used by parallel racer) */
async function fetchCuesFromPipedInstance(
  videoId: string,
  lang: string,
  instance: string,
): Promise<CaptionCueRaw[]> {
  const res = await fetchWithTimeout(
    `https://${instance}/streams/${videoId}`,
    { headers: { Accept: "application/json" } },
    5000,
  );
  if (!res.ok) throw new Error(`Piped cues ${instance}: HTTP ${res.status}`);

  const data = await res.json();
  const subtitles: { url?: string; code?: string }[] = data.subtitles;
  if (!Array.isArray(subtitles)) throw new Error(`Piped cues ${instance}: no subtitles array`);

  const sub = subtitles.find((s) => s.code === lang);
  if (!sub?.url) throw new Error(`Piped cues ${instance}: no subtitle for lang="${lang}"`);

  const vttRes = await fetchWithTimeout(sub.url, {}, 5000);
  if (!vttRes.ok) throw new Error(`Piped cues ${instance}: VTT fetch HTTP ${vttRes.status}`);

  const vtt = await vttRes.text();
  if (!vtt || !vtt.includes("-->")) throw new Error(`Piped cues ${instance}: invalid VTT`);

  const cues = parseWebVTT(vtt);
  if (cues.length === 0) throw new Error(`Piped cues ${instance}: 0 cues parsed`);

  console.log(
    `[captions] piped cues (${instance}): got ${cues.length} cue(s) for ${videoId}/${lang}`,
  );
  return cues;
}

/** Fetch caption cues from Piped API (races PIPED_RACE_SIZE random instances in parallel) */
async function fetchCuesFromPiped(videoId: string, lang: string): Promise<CaptionCueRaw[] | null> {
  const candidates = shuffle(PIPED_INSTANCES).slice(0, PIPED_RACE_SIZE);
  try {
    return await Promise.any(
      candidates.map((inst) => fetchCuesFromPipedInstance(videoId, lang, inst)),
    );
  } catch (err) {
    if (err instanceof AggregateError) {
      for (const e of err.errors) {
        console.warn(`[captions] piped cue race: ${e instanceof Error ? e.message : e}`);
      }
    }
    return null;
  }
}

/** Fetch caption tracks: InnerTube mobile clients first (POT-free URLs), watch page fallback */
async function fetchCaptionTracks(videoId: string, remainingMs: () => number = () => 9000) {
  // Primary: InnerTube mobile clients (IOS/ANDROID return caption URLs without POT requirement)
  let lastError: Error | null = null;
  let result: {
    videoId: string;
    title: string;
    channelName: string;
    thumbnailUrl: string;
    captionTracks: {
      languageCode: string;
      name: string;
      isAutoGenerated: boolean;
      baseUrl: string;
    }[];
  } | null = null;

  for (const client of INNERTUBE_CLIENTS) {
    if (remainingMs() < 1000) {
      console.warn(
        `[captions] deadline approaching (${remainingMs()}ms left), skipping ${client.label}`,
      );
      break;
    }
    try {
      const r = await tryFetchWithClient(videoId, client, remainingMs);

      if (r.captionTracks.length === 0) {
        console.warn(
          `[captions] ${client.label}: no caption tracks returned for ${videoId}, trying next client`,
        );
        continue;
      }

      console.log(
        `[captions] ${client.label}: found ${r.captionTracks.length} caption track(s) for ${videoId}`,
      );

      result = r;
      break;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[captions] ${client.label} failed for ${videoId}: ${lastError.message}`);
    }
  }

  // Fallback: watch page scraping (may return POT-required URLs, but still useful for metadata)
  if (!result && remainingMs() >= 1000) {
    try {
      const r = await fetchFromWatchPage(videoId, remainingMs);

      if (r.captionTracks.length > 0) {
        console.log(
          `[captions] watch page: found ${r.captionTracks.length} track(s) for ${videoId}`,
        );
        result = r;
      }
    } catch (err) {
      console.warn(
        `[captions] watch page failed for ${videoId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Fallback: Piped API (proxies through own servers, bypasses YouTube IP blocks)
  if (!result && ENABLE_PIPED_FALLBACK) {
    try {
      const pipedResult = await fetchTracksFromPiped(videoId);
      if (pipedResult && pipedResult.captionTracks.length > 0) {
        result = pipedResult;
      }
    } catch (err) {
      console.warn(
        `[captions] piped failed for ${videoId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Fallback: Invidious API (most instances have API disabled, kept for future re-activation)
  if (!result && ENABLE_INVIDIOUS_FALLBACK) {
    try {
      const invResult = await fetchTracksFromInvidious(videoId);
      if (invResult && invResult.captionTracks.length > 0) {
        result = invResult;
      }
    } catch (err) {
      console.warn(
        `[captions] invidious failed for ${videoId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // All methods failed — return empty result
  if (!result) {
    result = {
      videoId,
      title: "Unknown",
      channelName: "Unknown",
      thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      captionTracks: [],
    };
  }

  // Supplement metadata via oEmbed if title/channelName are missing (applies to all paths)
  if (result.title === "Unknown" || result.channelName === "Unknown") {
    const oEmbed = await fetchOEmbedMeta(videoId);
    if (oEmbed) {
      if (result.title === "Unknown") result.title = oEmbed.title;
      if (result.channelName === "Unknown") result.channelName = oEmbed.channelName;
      console.log(
        `[captions] oEmbed supplement: title="${result.title}", channel="${result.channelName}"`,
      );
    }
  }

  // If we have no tracks and no useful metadata, throw the last error
  if (result.captionTracks.length === 0 && result.title === "Unknown" && lastError) {
    throw lastError;
  }

  return result;
}

/** Fetch and parse caption cues from a baseUrl, with Piped / Invidious fallback */
async function fetchCaptionCues(
  baseUrl: string,
  videoId: string,
  lang: string,
  remainingMs: () => number = () => 9000,
): Promise<CaptionCueRaw[]> {
  // Try baseUrl + fmt=json3 (YouTube timedtext JSON format)
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");

    const res = await fetchWithTimeout(
      url.toString(),
      {
        headers: {
          "User-Agent":
            "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
        },
      },
      Math.min(4000, remainingMs()),
    );

    if (res.ok) {
      const text = await res.text();
      if (text) {
        // Try JSON3 (YouTube timedtext) first
        try {
          const data = JSON.parse(text);
          if (data.events) {
            const cues: CaptionCueRaw[] = [];

            for (const event of data.events) {
              if (!event.segs) continue;

              const segText = event.segs
                .map((s: { utf8?: string }) => s.utf8 ?? "")
                .join("")
                .replace(/\n/g, " ")
                .trim();

              if (!segText) continue;

              const startMs: number = event.tStartMs ?? 0;
              const durationMs: number = event.dDurationMs ?? 0;
              const start = startMs / 1000;
              const duration = durationMs / 1000;

              cues.push({
                start,
                duration,
                end: start + duration,
                text: segText,
              });
            }

            if (cues.length > 0) return cues;
          }
        } catch {
          // JSON parse failed — check if response is WebVTT (Invidious URLs return WebVTT)
          if (text.includes("-->")) {
            console.log("[captions] baseUrl returned WebVTT instead of JSON3, parsing as WebVTT");
            const cues = parseWebVTT(text);
            if (cues.length > 0) return cues;
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[captions] timedtext fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // Fallback: Piped API (proxies subtitle content, parallel racing)
  if (ENABLE_PIPED_FALLBACK) {
    const pipedCues = await fetchCuesFromPiped(videoId, lang);
    if (pipedCues && pipedCues.length > 0) return pipedCues;
  }

  // Fallback: Invidious WebVTT (most instances have API disabled, kept for future re-activation)
  if (ENABLE_INVIDIOUS_FALLBACK) {
    const invCues = await fetchCuesFromInvidious(videoId, lang);
    if (invCues && invCues.length > 0) return invCues;
  }

  throw new Error("Failed to fetch caption cues from timedtext");
}

const SENTENCE_SPLIT_RE = /(?<=[.?!。？！])\s*/;
const MERGE_MAX_DURATION = 15;
const MERGE_MAX_CHARS = 200;

/**
 * Interpolate a timestamp within a cue based on character position.
 * ASR cues have uniform speech rate assumption within each cue.
 */
function interpolateTime(cue: CaptionCueRaw, charOffset: number): number {
  if (cue.text.length === 0) return cue.start;
  const ratio = charOffset / cue.text.length;
  return cue.start + (cue.end - cue.start) * ratio;
}

/** Split each cue into sentence-level fragments, preserving timing via interpolation */
function splitCuesIntoSentences(cues: CaptionCueRaw[]): CaptionCueRaw[] {
  const fragments: CaptionCueRaw[] = [];
  for (const cue of cues) {
    const parts = cue.text.split(SENTENCE_SPLIT_RE);
    if (parts.length <= 1) {
      fragments.push(cue);
      continue;
    }
    let charPos = 0;
    for (const part of parts) {
      if (!part) continue;
      const fragStart = interpolateTime(cue, charPos);
      charPos += part.length;
      // Account for the split separator (whitespace between sentences)
      const sepMatch = cue.text.slice(charPos).match(/^\s*/);
      if (sepMatch?.[0]) charPos += sepMatch[0].length;
      const fragEnd = interpolateTime(cue, charPos);
      fragments.push({
        start: fragStart,
        end: fragEnd || cue.end,
        duration: (fragEnd || cue.end) - fragStart,
        text: part,
      });
    }
  }
  return fragments;
}

/** Merge consecutive cues at sentence boundaries for natural practice units */
function mergeCues(cues: CaptionCueRaw[]): CaptionCueRaw[] {
  if (cues.length === 0) return [];

  // First split mid-cue sentences, then merge at sentence boundaries
  const fragments = splitCuesIntoSentences(cues);

  const merged: CaptionCueRaw[] = [];
  let bufStart = 0;
  let bufEnd = 0;
  let bufTexts: string[] = [];
  let bufChars = 0;

  function flush() {
    if (bufTexts.length === 0) return;
    const text = bufTexts.join(" ");
    merged.push({
      start: bufStart,
      end: bufEnd,
      duration: bufEnd - bufStart,
      text,
    });
    bufTexts = [];
    bufChars = 0;
  }

  function startNewBuf(frag: CaptionCueRaw) {
    bufStart = frag.start;
    bufEnd = frag.end;
    bufTexts = [frag.text];
    bufChars = frag.text.length;
  }

  for (const frag of fragments) {
    // If buffer is empty, start a new one
    if (bufTexts.length === 0) {
      startNewBuf(frag);
    } else {
      const wouldDuration = frag.end - bufStart;
      const wouldChars = bufChars + 1 + frag.text.length;

      // Force flush if adding this fragment would exceed limits
      if (wouldDuration > MERGE_MAX_DURATION || wouldChars > MERGE_MAX_CHARS) {
        flush();
        startNewBuf(frag);
      } else {
        bufEnd = frag.end;
        bufTexts.push(frag.text);
        bufChars = wouldChars;
      }
    }

    // Flush at sentence boundary
    if (/[.?!。？！]$/.test(frag.text)) {
      flush();
    }
  }

  flush();

  return merged;
}

/** Debug diagnostics: test each fetch step independently */
async function runDebugDiagnostics(videoId: string, lang?: string) {
  const startTime = Date.now();
  // biome-ignore lint/suspicious/noExplicitAny: debug diagnostics collect heterogeneous step results
  const steps: Record<string, any> = {};

  // 1. Watch page
  try {
    const res = await fetchWithTimeout(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Cookie: YT_CONSENT_COOKIES,
        },
      },
      8000,
    );
    const html = await res.text();
    const hasPlayerResponse = html.includes("var ytInitialPlayerResponse = ");
    const hasConsentForm = html.includes("consent.youtube.com") || html.includes("CONSENT");
    steps.watchPage = {
      status: res.status,
      htmlLength: html.length,
      hasPlayerResponse,
      hasConsentForm,
    };
  } catch (err) {
    steps.watchPage = {
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // 2. InnerTube clients
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const res = await fetchWithTimeout(
        "https://www.youtube.com/youtubei/v1/player",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": client.userAgent,
            Cookie: YT_CONSENT_COOKIES,
          },
          body: JSON.stringify({ videoId, context: client.context }),
        },
        3000,
      );
      const data = await res.json();
      const rawTracks: InnerTubeTrack[] =
        data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      steps[`innerTube_${client.label}`] = {
        status: res.status,
        hasVideoDetails: !!data.videoDetails,
        title: data.videoDetails?.title ?? null,
        hasCaptions: !!data.captions?.playerCaptionsTracklistRenderer,
        trackCount: rawTracks.length,
        rawTracks: rawTracks.map((t) => ({
          languageCode: t.languageCode ?? null,
          vssId: t.vssId ?? null,
          kind: t.kind ?? null,
          hasBaseUrl: !!t.baseUrl,
        })),
      };
    } catch (err) {
      steps[`innerTube_${client.label}`] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 3. Invidious instances
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetchWithTimeout(
        `https://${instance}/api/v1/captions/${videoId}`,
        { headers: { Accept: "application/json" } },
        4000,
      );
      if (res.ok) {
        const data = await res.json();
        const captions = data.captions ?? data;
        steps[`invidious_${instance}`] = {
          status: res.status,
          trackCount: Array.isArray(captions) ? captions.length : 0,
          tracks: Array.isArray(captions)
            ? captions.map((c: { label?: string; language_code?: string; url?: string }) => ({
                label: c.label,
                lang: c.language_code,
                hasUrl: !!c.url,
              }))
            : [],
        };
      } else {
        steps[`invidious_${instance}`] = { status: res.status, error: "Non-OK response" };
      }
    } catch (err) {
      steps[`invidious_${instance}`] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 4. Piped instances
  for (const instance of PIPED_INSTANCES) {
    try {
      const res = await fetchWithTimeout(
        `https://${instance}/streams/${videoId}`,
        { headers: { Accept: "application/json" } },
        5000,
      );
      if (res.ok) {
        const data = await res.json();
        const subtitles: { name?: string; code?: string; url?: string }[] = data.subtitles ?? [];
        steps[`piped_${instance}`] = {
          status: res.status,
          title: data.title ?? null,
          subtitleCount: subtitles.length,
          subtitles: subtitles.map((s) => ({
            name: s.name,
            code: s.code,
            hasUrl: !!s.url,
          })),
        };
      } else {
        steps[`piped_${instance}`] = { status: res.status, error: "Non-OK response" };
      }
    } catch (err) {
      steps[`piped_${instance}`] = {
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 5. oEmbed
  const oEmbed = await fetchOEmbedMeta(videoId);
  steps.oEmbed = oEmbed ?? { error: "Failed or returned null" };

  // 5. Cue fetch diagnostics (when lang is provided)
  if (lang) {
    // biome-ignore lint/suspicious/noExplicitAny: debug diagnostics collect heterogeneous results
    const cueFetch: Record<string, any> = {};

    // Find matching track's baseUrl
    let trackBaseUrl: string | null = null;
    try {
      const meta = await fetchCaptionTracks(videoId);
      const track = meta.captionTracks.find((t) => t.languageCode === lang);
      cueFetch.trackFound = !!track;
      cueFetch.trackBaseUrl = track?.baseUrl ?? null;
      cueFetch.allTrackLangs = meta.captionTracks.map((t) => t.languageCode);
      trackBaseUrl = track?.baseUrl ?? null;
    } catch (err) {
      cueFetch.trackError = err instanceof Error ? err.message : String(err);
    }

    if (trackBaseUrl) {
      // Step 1: baseUrl + fmt=json3 + YouTube UA
      try {
        const url = new URL(trackBaseUrl);
        url.searchParams.set("fmt", "json3");
        cueFetch.step1_url = url.toString();
        const res = await fetchWithTimeout(
          url.toString(),
          {
            headers: {
              "User-Agent":
                "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
            },
          },
          8000,
        );
        const text = await res.text();
        cueFetch.step1 = {
          status: res.status,
          contentLength: text.length,
          contentPreview: text.slice(0, 200),
          isJSON: text.startsWith("{") || text.startsWith("["),
          hasVTTMarker: text.includes("-->"),
        };
        // Try parse as JSON3
        try {
          const data = JSON.parse(text);
          cueFetch.step1.eventCount = data.events?.length ?? 0;
        } catch {
          if (text.includes("-->")) {
            cueFetch.step1.webvttCueCount = parseWebVTT(text).length;
          }
        }
      } catch (err) {
        cueFetch.step1 = { error: err instanceof Error ? err.message : String(err) };
      }

      // Step 2: baseUrl as-is (no UA)
      try {
        cueFetch.step2_url = trackBaseUrl;
        const res = await fetchWithTimeout(trackBaseUrl, {}, 8000);
        const text = await res.text();
        cueFetch.step2 = {
          status: res.status,
          contentLength: text.length,
          contentPreview: text.slice(0, 200),
          hasVTTMarker: text.includes("-->"),
        };
        if (text.includes("-->")) {
          cueFetch.step2.webvttCueCount = parseWebVTT(text).length;
        }
      } catch (err) {
        cueFetch.step2 = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Step 3: Invidious cue fetch per instance (try both lang= and label= queries)
    const debugIsLangCode = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang);
    const debugQueries: { key: string; query: string }[] = [];
    if (debugIsLangCode) {
      debugQueries.push({ key: "lang", query: `lang=${encodeURIComponent(lang)}` });
      const labelName = LANG_CODE_TO_LABEL[lang];
      if (labelName) {
        debugQueries.push({ key: "label", query: `label=${encodeURIComponent(labelName)}` });
      }
    } else {
      debugQueries.push({ key: "label", query: `label=${encodeURIComponent(lang)}` });
    }
    for (const instance of INVIDIOUS_INSTANCES) {
      for (const { key, query } of debugQueries) {
        const stepKey = `step3_${instance}_${key}`;
        const invUrl = `https://${instance}/api/v1/captions/${videoId}?${query}`;
        try {
          cueFetch[`${stepKey}_url`] = invUrl;
          const res = await fetchWithTimeout(invUrl, {}, 4000);
          const text = await res.text();
          cueFetch[stepKey] = {
            status: res.status,
            contentLength: text.length,
            contentPreview: text.slice(0, 200),
            hasVTTMarker: text.includes("-->"),
            webvttCueCount: text.includes("-->") ? parseWebVTT(text).length : 0,
          };
        } catch (err) {
          cueFetch[stepKey] = {
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    }

    // Step 4: Piped cue fetch per instance
    for (const instance of PIPED_INSTANCES) {
      const stepKey = `step4_piped_${instance}`;
      try {
        const res = await fetchWithTimeout(
          `https://${instance}/streams/${videoId}`,
          { headers: { Accept: "application/json" } },
          5000,
        );
        if (!res.ok) {
          cueFetch[stepKey] = { status: res.status, error: "Non-OK response" };
          continue;
        }
        const data = await res.json();
        const subtitles: { url?: string; code?: string }[] = data.subtitles ?? [];
        const sub = subtitles.find((s) => s.code === lang);
        if (!sub?.url) {
          cueFetch[stepKey] = {
            availableCodes: subtitles.map((s) => s.code),
            error: `No subtitle found for lang="${lang}"`,
          };
          continue;
        }
        cueFetch[`${stepKey}_url`] = sub.url;
        const vttRes = await fetchWithTimeout(sub.url, {}, 5000);
        const text = await vttRes.text();
        cueFetch[stepKey] = {
          status: vttRes.status,
          contentLength: text.length,
          contentPreview: text.slice(0, 200),
          hasVTTMarker: text.includes("-->"),
          webvttCueCount: text.includes("-->") ? parseWebVTT(text).length : 0,
        };
      } catch (err) {
        cueFetch[stepKey] = {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    steps.cueFetch = cueFetch;
  }

  return {
    videoId,
    timestamp: new Date().toISOString(),
    region: process.env.VERCEL_REGION ?? "local",
    elapsedMs: Date.now() - startTime,
    steps,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const videoParam = searchParams.get("v");
  const lang = searchParams.get("lang");
  const kind = searchParams.get("kind");
  const merge = searchParams.get("merge");
  const debug = searchParams.get("debug");

  if (!videoParam) {
    return NextResponse.json({ error: "Missing video ID or URL (?v=...)" }, { status: 400 });
  }

  const videoId = extractVideoId(videoParam);
  if (!videoId) {
    return NextResponse.json({ error: "Invalid YouTube video ID or URL" }, { status: 400 });
  }

  // Debug mode: return diagnostics for each fetch step
  if (debug === "1") {
    const diagnostics = await runDebugDiagnostics(videoId, lang ?? undefined);
    return NextResponse.json(diagnostics, {
      headers: { "Cache-Control": "no-store" },
    });
  }

  try {
    const deadline = Date.now() + VERCEL_DEADLINE_MS;
    const remainingMs = () => Math.max(deadline - Date.now(), 500);

    const meta = await fetchCaptionTracks(videoId, remainingMs);

    // Only cache responses that have caption tracks (avoid caching empty/broken results)
    const cacheHeaders =
      meta.captionTracks.length > 0
        ? { "Cache-Control": "public, max-age=3600, s-maxage=3600" }
        : { "Cache-Control": "no-store" };

    // If no lang requested, return just the track list
    if (!lang) {
      return NextResponse.json(meta, { headers: cacheHeaders });
    }

    // Find the requested track (kind=asr distinguishes auto-generated from official)
    const track = meta.captionTracks.find(
      (t) => t.languageCode === lang && (kind ? (kind === "asr") === t.isAutoGenerated : true),
    );
    if (!track) {
      return NextResponse.json(
        { error: `No caption track found for language: ${lang}` },
        { status: 404 },
      );
    }

    const rawCues = await fetchCaptionCues(track.baseUrl, videoId, lang, remainingMs);
    const cues = merge === "0" ? rawCues : mergeCues(rawCues);

    return NextResponse.json({ ...meta, cues }, { headers: cacheHeaders });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
