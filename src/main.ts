import { device } from "@shared/device";
import { loadValues } from "@shared/settings";
import manifest from "./appmeta/manifest.json";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

const NOW_PLAYING_URL = "https://api.spotify.com/v1/me/player/currently-playing?market=from_token";
/**
 * Answers [true] or [false] for whether a track (by URI) is in the user's Liked Songs. Needs the user-library-read
 * scope. Replaces /me/tracks/contains, which answers 403 to Development Mode apps since Spotify's February 2026 changes.
 */
const LIKED_URL = "https://api.spotify.com/v1/me/library/contains";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
/** Where the player and library commands go. */
const API_URL = "https://api.spotify.com/v1";

/** How often Spotify is asked while something plays, and while nothing does. */
const POLL_PLAYING_MS = 5000;
const POLL_IDLE_MS = 15000;
/** How often the liked state of the same track is asked again, so a like or unlike shows up mid-song. */
const LIKE_RECHECK_MS = 15000;
/** Failed requests back off from the first value, doubling up to the second. */
const BACKOFF_MIN_MS = 10000;
const BACKOFF_MAX_MS = 120000;
/** How often the progress bar is moved between polls. */
const PROGRESS_TICK_MS = 1000;
/** After a command, Spotify is asked again this soon, so a skip shows the new song without waiting for the next poll. */
const COMMAND_REFRESH_MS = 1000;
/** How long a failed command's message stays before the track is drawn again. */
const COMMAND_ERROR_MS = 3000;

const WIDTH = 72;
const WHITE = "#FFFFFFFF";
const GREEN = "#1DB954FF";
const DIM = "#FFFFFF60";
const BAR_TRACK = "#FFFFFF30";

/** Firmware scrolling for text wider than the screen: pixels per minute, then pauses in ms. */
const SCROLL = { scroll_rate: 1200, scroll_start_delay: 1500, scroll_repeat_delay: 2500 };

type Credentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
};

/** What Spotify last said is playing; progress is extrapolated from `fetchedAt` while playing. */
type Track = {
  /** The Spotify track id, or null for podcast episodes and local files, which cannot be liked as tracks. */
  id: string | null;
  title: string;
  artist: string;
  progressMs: number;
  durationMs: number;
  playing: boolean;
  fetchedAt: number;
  liked: boolean;
};

/** A non-OK answer, kept apart from network failures so 401 and 429 can be handled. */
class HttpError extends Error {
  readonly status: number;
  readonly retryAfterS: number;
  /** The start of the answer's body, when it was read: Spotify names the reason there, e.g. PREMIUM_REQUIRED. */
  readonly reason: string;

  constructor(status: number, retryAfterS: number, reason = "") {
    super(reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`);
    this.status = status;
    this.retryAfterS = retryAfterS;
    this.reason = reason;
  }
}

type Element = Parameters<typeof device.DisplayDraw>[0]["elements"][number];

/** A few common accented letters the bitmap fonts cannot draw; anything else outside ASCII becomes "?". */
const ACCENTS: Record<string, string> = {
  á: "a", à: "a", â: "a", ä: "a", ã: "a", å: "a", é: "e", è: "e", ê: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i", ó: "o", ò: "o", ô: "o", ö: "o", õ: "o", ø: "o",
  ú: "u", ù: "u", û: "u", ü: "u", ñ: "n", ç: "c", ß: "ss",
  Á: "A", À: "A", Ä: "A", É: "E", Í: "I", Ó: "O", Ö: "O", Ú: "U", Ü: "U", Ñ: "N",
  "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-",
};

function ascii(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    out += code >= 32 && code < 127 ? ch : (ACCENTS[ch] ?? "?");
  }
  return out;
}

function stringValue(values: Record<string, unknown>, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Sends display changes one request at a time. Elements changed while a request is in flight are merged by id and go
 * out in the next one, so a slow device never builds a queue.
 */
function createDisplay(report: (err: unknown) => void) {
  const pending = new Map<string, Element>();
  /** What the screen shows now, by id, so unchanged elements are not resent. */
  const shown = new Map<string, string>();
  const toClear = new Set<string>();
  let busy = false;

  async function flush(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (pending.size > 0 || toClear.size > 0) {
        if (toClear.size > 0) {
          const element_ids = Array.from(toClear);
          toClear.clear();
          await device.DisplayClear({ application_name: APP, element_ids });
        }
        if (pending.size > 0) {
          const elements = Array.from(pending.values());
          pending.clear();
          await device.DisplayDraw({ application_name: APP, priority: 50, elements });
        }
      }
    } finally {
      busy = false;
    }
  }

  return {
    /** Draws the elements that differ from what is on screen and removes the shown ids not among them. */
    show(elements: Element[]): void {
      const keep = new Set<string>();
      for (const element of elements) {
        keep.add(element.id);
        const key = JSON.stringify(element);
        if (shown.get(element.id) === key) continue;
        shown.set(element.id, key);
        pending.set(element.id, element);
        toClear.delete(element.id);
      }
      for (const id of Array.from(shown.keys())) {
        if (keep.has(id)) continue;
        shown.delete(id);
        pending.delete(id);
        toClear.add(id);
      }
      void flush().catch(report);
    },
  };
}

function messageElements(top: string, bottom: string): Element[] {
  return [
    { id: "title", type: "text", text: top, font: "small", color: WHITE, x: 36, y: 0, align: "top_mid", width: WIDTH, ...SCROLL },
    { id: "artist", type: "text", text: bottom, font: "tiny", color: DIM, x: 36, y: 10, align: "top_mid", width: WIDTH, ...SCROLL },
  ];
}

const RED = "#FF3B5CFF";

/** A 5x4 heart drawn as one rectangle per lit run of pixels, with its top left at (x, y). */
function heart(x: number, y: number): Element[] {
  const px = (id: string, dx: number, dy: number, width: number): Element => ({
    id, type: "rectangle", x: x + dx, y: y + dy, width, height: 1,
    fill: "solid", fill_colors: [RED], border_width: 0, z_index: 2,
  });
  return [
    px("heart_0a", 1, 0, 1),
    px("heart_0b", 3, 0, 1),
    px("heart_1", 0, 1, 5),
    px("heart_2", 1, 2, 3),
    px("heart_3", 2, 3, 1),
  ];
}

function trackElements(track: Track, now: number): Element[] {
  const progress = track.playing ? track.progressMs + (now - track.fetchedAt) : track.progressMs;
  const fraction = track.durationMs > 0 ? Math.min(1, Math.max(0, progress / track.durationMs)) : 0;
  const filled = Math.round(fraction * WIDTH);

  const elements: Element[] = [
    { id: "title", type: "text", text: track.title, font: "small", color: track.playing ? WHITE : DIM, x: 0, y: 0, align: "top_left", width: WIDTH, ...SCROLL },
    // The artist line leaves room for the heart only when the heart is shown.
    { id: "artist", type: "text", text: track.artist, font: "tiny", color: GREEN, x: 0, y: 9, align: "top_left", width: track.liked ? 65 : WIDTH, ...SCROLL },
    { id: "bar_track", type: "rectangle", x: 0, y: 15, width: WIDTH, height: 1, fill: "solid", fill_colors: [BAR_TRACK], border_width: 0 },
  ];
  // A rectangle needs some width: an empty bar is just the track.
  if (filled > 0) {
    elements.push({ id: "bar_fill", type: "rectangle", x: 0, y: 15, width: filled, height: 1, fill: "solid", fill_colors: [track.playing ? WHITE : DIM], border_width: 0, z_index: 1 });
  }
  // Left out when not liked, so the display clears the heart's pixels.
  if (track.liked) elements.push(...heart(67, 10));
  return elements;
}

function readTrack(body: unknown, fetchedAt: number): Track | null {
  const data = body as {
    is_playing?: boolean;
    progress_ms?: number;
    item?: {
      id?: string | null;
      type?: string;
      is_local?: boolean;
      name?: string;
      duration_ms?: number;
      artists?: { name?: string }[];
      show?: { name?: string };
    } | null;
  } | null;
  const item = data?.item;
  if (!item || !item.name) return null;

  // Tracks have artists; podcast episodes have a show instead.
  const artists = (item.artists ?? []).map((artist) => artist.name ?? "").filter((name) => name !== "");
  const artist = artists.length > 0 ? artists.join(", ") : (item.show?.name ?? "");
  const id = item.type === "track" && !item.is_local && item.id ? item.id : null;

  return {
    id,
    title: ascii(item.name),
    artist: ascii(artist),
    progressMs: data?.progress_ms ?? 0,
    durationMs: item.duration_ms ?? 0,
    playing: data?.is_playing === true,
    fetchedAt,
    liked: false,
  };
}

function retryAfter(res: Response): number {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Trades the refresh token for an access token. Spotify may hand back a new refresh token; it is kept for this run. */
async function refreshAccessToken(creds: Credentials): Promise<void> {
  const body =
    "grant_type=refresh_token" +
    `&refresh_token=${encodeURIComponent(creds.refreshToken)}` +
    `&client_id=${encodeURIComponent(creds.clientId)}` +
    `&client_secret=${encodeURIComponent(creds.clientSecret)}`;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new HttpError(res.status, retryAfter(res));

  const data = (await res.json()) as { access_token?: string; refresh_token?: string };
  if (!data.access_token) throw new Error("token answer had no access_token");
  creds.accessToken = data.access_token;
  if (data.refresh_token) creds.refreshToken = data.refresh_token;
}

/** Asks what is playing. Null when nothing is (HTTP 204, or an answer without an item). */
async function fetchNowPlaying(accessToken: string): Promise<Track | null> {
  const res = await fetch(NOW_PLAYING_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 204) return null;
  if (!res.ok) throw new HttpError(res.status, retryAfter(res));
  return readTrack(await res.json(), Date.now());
}

/** Asks whether one track is in the user's Liked Songs. */
async function fetchLiked(accessToken: string, trackId: string): Promise<boolean> {
  const res = await fetch(`${LIKED_URL}?uris=${encodeURIComponent(`spotify:track:${trackId}`)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new HttpError(res.status, retryAfter(res));
  const data = (await res.json()) as unknown;
  return Array.isArray(data) && data[0] === true;
}

/** Sends one player or library command. Spotify answers it with 200, 202 or 204 and nothing the app needs. */
async function sendCommand(accessToken: string, method: "PUT" | "POST" | "DELETE", path: string): Promise<void> {
  // Spotify answers 411 to a command sent without a length, so an empty body is sent with an explicit one.
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Length": "0" },
    body: "",
  });
  if (res.ok) return;
  // The error body is short and names the reason, such as PREMIUM_REQUIRED or NO_ACTIVE_DEVICE.
  const reason = (await res.text()).slice(0, 200);
  throw new HttpError(res.status, retryAfter(res), reason);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  let stopped = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let track: Track | null = null;
  let backoffMs = BACKOFF_MIN_MS;
  let creds: Credentials | null = null;
  /** The last liked answer, so the same track is not asked about on every poll. */
  let likeCache: { id: string; liked: boolean; checkedAt: number } | null = null;
  /** Set after a 403 on the liked check (token lacks user-library-read), so the error is reported once, not every poll. */
  let likeDenied = false;
  /** After a 429 on the liked check, no liked check is sent before this time. */
  let likeRetryAt = 0;
  /** True while a poll round runs, so a command never starts a second one beside it. */
  let polling = false;
  /** Set by a command during a poll round: that round then asks again soon instead of after the usual wait. */
  let refreshSoon = false;
  /** One command at a time: presses and wheel turns while one is in flight are dropped, not queued. */
  let commandBusy = false;

  const report = (err: unknown) => console.error(`${APP}: ${describe(err)}`);
  const display = createDisplay(report);

  const canRefresh = () => !!creds && creds.clientId !== "" && creds.clientSecret !== "" && creds.refreshToken !== "";

  function stopProgress(): void {
    if (progressTimer === undefined) return;
    clearInterval(progressTimer);
    progressTimer = undefined;
  }

  /** Moves the bar only while a track plays; a paused track holds still and needs no timer. */
  function showTrack(): void {
    if (!track) return;
    display.show(trackElements(track, Date.now()));
    if (track.playing && progressTimer === undefined) {
      progressTimer = setInterval(() => {
        if (track) display.show(trackElements(track, Date.now()));
      }, PROGRESS_TICK_MS);
    } else if (!track.playing) {
      stopProgress();
    }
  }

  function showMessage(top: string, bottom: string): void {
    stopProgress();
    display.show(messageElements(top, bottom));
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void poll();
    }, delayMs);
  }

  /**
   * Fills in `next.liked`, asking Spotify only when the track changed or the last answer is old. A failure here keeps
   * the last known state and never stops the now-playing display.
   */
  async function updateLiked(next: Track): Promise<void> {
    if (!creds || !next.id || likeDenied) return;
    const now = Date.now();
    const known = likeCache?.id === next.id ? likeCache.liked : false;
    if (now < likeRetryAt || (likeCache?.id === next.id && now - likeCache.checkedAt < LIKE_RECHECK_MS)) {
      next.liked = known;
      return;
    }
    try {
      const liked = await fetchLiked(creds.accessToken, next.id);
      likeCache = { id: next.id, liked, checkedAt: now };
      next.liked = liked;
    } catch (err) {
      if (err instanceof HttpError && err.status === 403) {
        likeDenied = true;
        report(new Error("liked check refused: the refresh token needs the user-library-read scope"));
      } else {
        // Too many requests: wait as long as Spotify asks, or one recheck period.
        if (err instanceof HttpError && err.status === 429) likeRetryAt = now + Math.max(err.retryAfterS * 1000, LIKE_RECHECK_MS);
        report(err);
      }
      next.liked = known;
    }
  }

  /** Runs one request with the current access token, getting a new token and trying once more on 401. */
  async function withToken<T>(request: (accessToken: string) => Promise<T>): Promise<T> {
    if (!creds) throw new Error("no Spotify login");
    if (creds.accessToken === "" && canRefresh()) await refreshAccessToken(creds);
    try {
      return await request(creds.accessToken);
    } catch (err) {
      // An access token lasts an hour: on 401 get a new one and ask once more.
      if (!(err instanceof HttpError) || err.status !== 401 || !canRefresh()) throw err;
      await refreshAccessToken(creds);
      return await request(creds.accessToken);
    }
  }

  /** One poll round, then the next one scheduled. Never throws, and never runs twice at once. */
  async function poll(): Promise<void> {
    if (!creds || polling) return;
    polling = true;
    refreshSoon = false;
    const delay = await pollRound();
    polling = false;
    if (delay !== null) schedule(refreshSoon ? COMMAND_REFRESH_MS : delay);
  }

  /** Asks Spotify again shortly, so a command's effect shows without waiting for the next regular poll. */
  function pollSoon(delayMs: number): void {
    if (polling) refreshSoon = true;
    else schedule(delayMs);
  }

  /** Asks what plays and draws it. Gives the wait before the next round, or null once the app is stopping. */
  async function pollRound(): Promise<number | null> {
    try {
      const next = await withToken(fetchNowPlaying);
      if (next) await updateLiked(next);
      if (stopped) return null;

      backoffMs = BACKOFF_MIN_MS;
      track = next;
      if (track) showTrack();
      else showMessage("Nothing playing", "Spotify is idle");
      return track?.playing ? POLL_PLAYING_MS : POLL_IDLE_MS;
    } catch (err) {
      if (stopped) return null;
      report(err);
      let delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);

      if (err instanceof HttpError && (err.status === 400 || err.status === 401)) {
        // A bad refresh token or an expired access token will not fix itself: say so and wait longer.
        track = null;
        showMessage("Spotify login failed", canRefresh() ? "Check the app's settings" : "Token expired: set a new one");
        delay = BACKOFF_MAX_MS;
      } else if (err instanceof HttpError && err.status === 429) {
        delay = Math.max(delay, err.retryAfterS * 1000);
      } else if (!track) {
        showMessage("No connection", "Retrying...");
      }
      return delay;
    }
  }

  /** Shows for a moment why a command failed; the poll that follows draws the track again. */
  function commandFailed(err: unknown): void {
    report(err);
    if (stopped) return;
    const status = err instanceof HttpError ? err.status : 0;
    const reason = err instanceof HttpError ? err.reason : "";
    if (reason.includes("PREMIUM_REQUIRED")) showMessage("Needs Premium", "Spotify allows this only with Premium");
    else if (status === 404) showMessage("No active device", "Start playing on a device first");
    // A login without the command's permission gets 403, or 401 "Permissions missing".
    else if (status === 403 || reason.includes("Permissions missing")) showMessage("Spotify said no", "Run the token script again");
    else showMessage("That didn't work", "Try again");
    pollSoon(COMMAND_ERROR_MS);
  }

  /** Runs one command, then asks Spotify soon so its effect shows. Drops the command while another runs. */
  async function runCommand(command: () => Promise<void>): Promise<void> {
    if (stopped || commandBusy || !creds) return;
    commandBusy = true;
    try {
      await command();
      if (!stopped) pollSoon(COMMAND_REFRESH_MS);
    } catch (err) {
      commandFailed(err);
    } finally {
      commandBusy = false;
    }
  }

  /** Start: pauses a playing track, or plays (resuming the last one when nothing is shown). */
  async function togglePlay(): Promise<void> {
    const wasPlaying = track?.playing === true;
    await withToken((token) => sendCommand(token, "PUT", wasPlaying ? "/me/player/pause" : "/me/player/play"));
    if (!track || stopped) return;
    // Show the change at once: freeze or restart the progress bar from where it is now.
    const now = Date.now();
    if (track.playing) track.progressMs += now - track.fetchedAt;
    track.fetchedAt = now;
    track.playing = !wasPlaying;
    showTrack();
  }

  /** Wheel turn: the next song clockwise, the previous one counterclockwise. */
  async function skip(forward: boolean): Promise<void> {
    await withToken((token) => sendCommand(token, "POST", forward ? "/me/player/next" : "/me/player/previous"));
  }

  /** Wheel press: adds the track to Liked Songs, or takes it out when it is already there. */
  async function toggleLike(): Promise<void> {
    const id = track?.id;
    if (!id || !track) return;
    const liked = !track.liked;
    const uri = encodeURIComponent(`spotify:track:${id}`);
    await withToken((token) => sendCommand(token, liked ? "PUT" : "DELETE", `/me/library?uris=${uri}`));
    likeCache = { id, liked, checkedAt: Date.now() };
    if (track?.id === id && !stopped) {
      track.liked = liked;
      showTrack();
    }
  }

  async function start(): Promise<void> {
    const values = (await loadValues()) ?? {};
    if (stopped) return;
    creds = {
      clientId: stringValue(values, "client_id"),
      clientSecret: stringValue(values, "client_secret"),
      refreshToken: stringValue(values, "refresh_token"),
      accessToken: stringValue(values, "access_token"),
    };
    if (!canRefresh() && creds.accessToken === "") {
      // Nothing to poll with: the input listener alone keeps the app open until Back.
      showMessage("Set up Spotify", "Add a token in the app's settings");
      return;
    }
    showMessage("spot bar", "Connecting...");
    await poll();
  }

  void start().catch(report);

  // Start plays or pauses, the wheel skips, a wheel press likes. Back leaves the app: once the timers are cleared and
  // the handler detached, nothing keeps it alive and the device takes the screen back.
  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      void runCommand(() => skip(event.action === "clockwise")).catch(report);
      return;
    }
    if (event.action !== "short") return;
    if (event.key === "start") {
      void runCommand(togglePlay).catch(report);
      return;
    }
    if (event.key === "ok") {
      void runCommand(toggleLike).catch(report);
      return;
    }

    stopped = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    stopProgress();

    // Not detached from inside the handler itself: with nothing else left the unbind stops the app on the spot, while this handler is still running.
    setTimeout(unbind, 0);
  });
}

main();
