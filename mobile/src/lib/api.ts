import AsyncStorage from '@react-native-async-storage/async-storage';

export const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8000';
export const INTERNAL_KEY = process.env.EXPO_PUBLIC_INTERNAL_KEY || '';
let AUTH_TOKEN = '';

export function setAuthToken(token: string) {
  AUTH_TOKEN = token;
}

export function clearAuthToken() {
  AUTH_TOKEN = '';
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (AUTH_TOKEN) headers.Authorization = `Bearer ${AUTH_TOKEN}`;
  else if (INTERNAL_KEY) headers['X-Internal-Key'] = INTERNAL_KEY;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export type GuestAuthOut = {
  token: string;
  user_id: number;
  name: string;
  expires_at: string;
};

export type OnboardingOut = {
  id: number;
  user_id: number;
  current_step?: number | null;
  start_date?: string | null;
  goal_date?: string | null;
  goal_primary?: string | null;
  ability_level?: string | null;
  weekly_availability?: number | null;
  time_per_run?: string | null;
  updated_at: string;
};

export type ProfileIn = {
  goal_mode: string;
  goal_primary: string;
  goal_date?: string;
  start_date?: string;
  ability_level: string;
  weekly_availability: number;
  time_per_run: string;
  injury_status: string;
  preferred_days: string;
  recent_runs_per_week?: number;
  longest_recent_min?: number;
  continuous_run_min?: number;
  run_walk_ok?: string;
};

export type WeeklyAvailabilityIn = {
  week_start: string;
  mon: boolean;
  tue: boolean;
  wed: boolean;
  thu: boolean;
  fri: boolean;
  sat: boolean;
  sun: boolean;
};

export type WeeklyAvailabilityOut = WeeklyAvailabilityIn & {
  id: number;
  user_id: number;
};

export function authGuest(name: string, device_id: string) {
  return req<GuestAuthOut>('/auth/guest', {
    method: 'POST',
    body: JSON.stringify({ name, device_id }),
  });
}

export function authMe() {
  return req<{ user_id: number; name: string; email?: string | null }>('/auth/me');
}

export function getOnboarding(userId: number) {
  return req<OnboardingOut>(`/users/${userId}/onboarding`);
}

export function upsertOnboarding(userId: number, payload: Record<string, unknown>) {
  return req<OnboardingOut>(`/users/${userId}/onboarding`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function upsertProfile(userId: number, payload: ProfileIn) {
  return req(`/users/${userId}/profile`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function setWeeklyAvailability(userId: number, payload: WeeklyAvailabilityIn) {
  return req<WeeklyAvailabilityOut>(`/users/${userId}/availability`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getWeeklyAvailability(userId: number, weekStart?: string) {
  const qs = weekStart ? `?week_start=${encodeURIComponent(weekStart)}` : '';
  return req<WeeklyAvailabilityOut>(`/users/${userId}/availability${qs}`);
}

export type MobilePlanToday = {
  user_id: number;
  day: string;
  session_type: string;
  planned_km: number;
  notes?: string | null;
  interval?: Record<string, string | number> | null;
};

export type MobileUpcomingWorkout = {
  day: string;
  session_type: string;
  planned_km: number;
  notes?: string | null;
  interval?: Record<string, string | number> | null;
  total_motion_min?: number | null;
};

export type MobilePlanUpcoming = {
  user_id: number;
  items: MobileUpcomingWorkout[];
};

export type MobileProgress = {
  user_id: number;
  week_start: string;
  week_motion_min: number;
  week_distance_km: number;
  total_distance_km: number;
  plan_adherence_pct: number;
  on_time_completion_pct: number;
  consistency_score: number;
  training_load_trend_pct: number;
  training_load_trend_label: 'building' | 'stable' | 'recovering';
};

export type MobileHistoryItem = {
  run_id: number;
  started_at: string;
  source: string;
  distance_m: number;
  duration_s: number;
  pace_min_km?: number | null;
  route_polyline?: string | null;
  effort?: string | null;
  fatigue?: string | null;
  pain?: string | null;
  session_feel?: string | null;
};

export type MobileHistory = {
  user_id: number;
  items: MobileHistoryItem[];
};

export type SessionStart = { id: number; user_id: number; started_at: string; status: string; run_id?: number | null };

function localIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getPlanToday(userId: number, clientDate?: string) {
  const date = clientDate || localIsoDate();
  return req<MobilePlanToday>(`/mobile/plan/today/${userId}?client_date=${date}`);
}

export function getPlanUpcoming(userId: number, limit = 5, includeRest = false) {
  const capped = Math.max(1, limit);
  return req<MobilePlanUpcoming>(
    `/mobile/plan/upcoming/${userId}?limit=${capped}&include_rest=${includeRest ? 'true' : 'false'}&client_date=${localIsoDate()}`
  ).catch(async (e) => {
    const msg = String((e as Error)?.message || '');
    if (!msg.includes('404')) throw e;
    const fallback = await getPlanUpcomingFallback(userId, capped, includeRest);
    return fallback;
  });
}

export function generatePlan(userId: number, weeks = 16) {
  return req<{ weeks: number; days: number }>(`/plans/generate/${userId}?weeks=${weeks}`, {
    method: 'POST',
  });
}

export function bootstrapProfile(userId: number) {
  return req(`/users/${userId}/profile/bootstrap`, { method: 'POST' });
}

export function getProgress(userId: number) {
  return req<MobileProgress>(`/mobile/progress/${userId}`);
}

export function getHistory(userId: number) {
  return req<MobileHistory>(`/mobile/history/${userId}`);
}

export function startSession(user_id: number) {
  return req<SessionStart>('/mobile/session/start', {
    method: 'POST',
    body: JSON.stringify({ user_id }),
  });
}

export function sessionEvent(sessionId: number, event_type: string, payload_json?: string) {
  return req<{ status: string }>(`/mobile/session/${sessionId}/event`, {
    method: 'POST',
    body: JSON.stringify({ event_type, payload_json }),
  });
}

type LegacyPlanDay = {
  day: string;
  session_type: string;
  planned_km: number;
  notes?: string | null;
};

type LegacyPlanWeek = {
  week_start: string;
  focus: string;
  target_km: number;
  days: LegacyPlanDay[];
};

function weekStartIso(baseIso: string, addWeeks = 0): string {
  const d = new Date(`${baseIso}T00:00:00`);
  const wd = d.getDay(); // Sun=0..Sat=6
  const monOffset = wd === 0 ? -6 : 1 - wd;
  d.setDate(d.getDate() + monOffset + addWeeks * 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseC25kFromNotes(notes?: string | null): Record<string, string | number> | null {
  const text = String(notes || '');
  if (!text.startsWith('C25K|')) return null;
  const out: Record<string, string | number> = {};
  for (const part of text.split('|').slice(1)) {
    const [k, v] = part.split('=');
    if (!k || v == null) continue;
    const n = Number(v);
    out[k] = Number.isFinite(n) ? n : v;
  }
  return out;
}

async function getPlanUpcomingFallback(
  userId: number,
  limit: number,
  includeRest: boolean
): Promise<MobilePlanUpcoming> {
  const today = localIsoDate();
  const weeks = [weekStartIso(today, 0), weekStartIso(today, 1), weekStartIso(today, 2)];
  const items: MobileUpcomingWorkout[] = [];
  for (const w of weeks) {
    try {
      const week = await req<LegacyPlanWeek>(`/plans/week/${userId}?week_start=${w}`);
      for (const d of week.days || []) {
        const interval = parseC25kFromNotes(d.notes);
        const isRest = String(d.session_type || '').toLowerCase() === 'rest';
        if (!includeRest && isRest) continue;
        if (String(d.day) < today) continue;
        let total_motion_min: number | null = null;
        if (interval) {
          const warmup = Number(interval.warmup || 0);
          const cooldown = Number(interval.cooldown || 0);
          const run = Number(interval.run || 0);
          const walk = Number(interval.walk || 0);
          const repeats = Number(interval.repeats || 0);
          total_motion_min = Math.round(warmup + cooldown + (run + walk) * repeats);
        }
        items.push({
          day: String(d.day),
          session_type: d.session_type,
          planned_km: Number(d.planned_km || 0),
          notes: d.notes || null,
          interval,
          total_motion_min,
        });
      }
    } catch {
      // Keep building from other weeks if one week is unavailable.
    }
  }
  items.sort((a, b) => String(a.day).localeCompare(String(b.day)));
  return { user_id: userId, items: items.slice(0, limit) };
}

export function stopSession(sessionId: number, distance_m: number, duration_s: number, route_polyline?: string) {
  return req<SessionStart>(`/mobile/session/${sessionId}/stop`, {
    method: 'POST',
    body: JSON.stringify({ distance_m, duration_s, route_polyline }),
  });
}

export function checkinSession(
  sessionId: number,
  payload: { effort: string; fatigue: string; pain: string; session_feel: string; notes?: string }
) {
  return req<{ actions_applied: string[] }>(`/mobile/session/${sessionId}/checkin`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

type PendingAction = {
  id: string;
  kind: 'event' | 'stop' | 'checkin';
  sessionId: number;
  payload: any;
  createdAt: string;
};

type ActiveSessionSnapshot = {
  userId: number;
  sessionId: number;
  startedAt: number;
  seconds: number;
  distanceM: number;
  isPaused: boolean;
  pauseAccumMs: number;
  backgroundMode: boolean;
  points: Array<{ latitude: number; longitude: number; ts: number }>;
};

const QUEUE_KEY = 'mcl_sync_queue_v1';
const ACTIVE_KEY = 'mcl_active_session_v1';

async function loadQueue(): Promise<PendingAction[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: PendingAction[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function enqueueAction(kind: PendingAction['kind'], sessionId: number, payload: any): Promise<void> {
  const queue = await loadQueue();
  queue.push({
    id: `${kind}-${sessionId}-${Date.now()}`,
    kind,
    sessionId,
    payload,
    createdAt: new Date().toISOString(),
  });
  await saveQueue(queue);
}

export async function flushSyncQueue(): Promise<{ flushed: number; remaining: number }> {
  const queue = await loadQueue();
  if (!queue.length) return { flushed: 0, remaining: 0 };
  const remaining: PendingAction[] = [];
  let flushed = 0;
  for (const item of queue) {
    try {
      if (item.kind === 'event') {
        await req<{ status: string }>(`/mobile/session/${item.sessionId}/event`, {
          method: 'POST',
          body: JSON.stringify(item.payload),
        });
      } else if (item.kind === 'stop') {
        await req(`/mobile/session/${item.sessionId}/stop`, {
          method: 'POST',
          body: JSON.stringify(item.payload),
        });
      } else if (item.kind === 'checkin') {
        await req(`/mobile/session/${item.sessionId}/checkin`, {
          method: 'POST',
          body: JSON.stringify(item.payload),
        });
      }
      flushed += 1;
    } catch {
      remaining.push(item);
    }
  }
  await saveQueue(remaining);
  return { flushed, remaining: remaining.length };
}

export async function getPendingSyncCount(): Promise<number> {
  return (await loadQueue()).length;
}

export async function saveActiveSession(snapshot: ActiveSessionSnapshot): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(snapshot));
}

export async function loadActiveSession(userId: number): Promise<ActiveSessionSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || Number(parsed.userId) !== Number(userId)) return null;
    return parsed as ActiveSessionSnapshot;
  } catch {
    return null;
  }
}

export async function clearActiveSession(): Promise<void> {
  await AsyncStorage.removeItem(ACTIVE_KEY);
}
