import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  getOnboarding,
  getHistory,
  getPlanToday,
  getPlanUpcoming,
  getProgress,
  MobileHistoryItem,
  MobileProgress,
  MobileUpcomingWorkout,
} from '../lib/api';
import { UnitSystem } from '../lib/units';
import { shadow, theme } from '../ui/theme';

type WeekStatus = { dayIso: string; ran: boolean; plannedRun: boolean; missedPlanned: boolean };
type WeekRow = { title: string; subtitle: string; days: WeekStatus[] };

export default function ProgressScreen({
  userId,
  isActive = true,
  unitSystem: _unitSystem,
}: {
  userId: number;
  isActive?: boolean;
  unitSystem: UnitSystem;
}) {
  const [data, setData] = useState<MobileProgress | null>(null);
  const [nextWorkouts, setNextWorkouts] = useState<MobileUpcomingWorkout[]>([]);
  const [todayWorkout, setTodayWorkout] = useState<MobileUpcomingWorkout | null>(null);
  const [history, setHistory] = useState<MobileHistoryItem[]>([]);
  const [weekRows, setWeekRows] = useState<WeekRow[]>([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [showNextDetails, setShowNextDetails] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const [progressRes, historyRes, todayRes] = await Promise.all([
        getProgress(userId, localIsoDate()),
        getHistory(userId).catch(() => ({ user_id: userId, items: [] })),
        getPlanToday(userId).catch(() => null),
      ]);
      const onboarding = await getOnboarding(userId).catch(() => null);
      const startDateIso = onboarding?.start_date || localIsoDate();
      setData(progressRes);
      setHistory(historyRes.items || []);
      if (todayRes && String(todayRes.session_type || '').toLowerCase() !== 'rest') {
        setTodayWorkout({
          day: localIsoDate(),
          session_type: todayRes.session_type,
          planned_km: todayRes.planned_km,
          notes: todayRes.notes,
          interval: todayRes.interval,
          total_motion_min: todayRes.total_motion_min,
        });
      } else {
        setTodayWorkout(null);
      }
      try {
        const planRes = await getPlanUpcoming(userId, 8, false);
        setNextWorkouts((planRes.items || []).filter((w) => String(w.session_type || '').toLowerCase() !== 'rest'));
      } catch {
        setNextWorkouts([]);
      }
      try {
        const weeks = await loadWeekStatuses(userId, historyRes.items || [], startDateIso);
        setWeekRows(weeks);
      } catch {
        setWeekRows([]);
      }
    } catch (e: any) {
      setData(null);
      setNextWorkouts([]);
      setTodayWorkout(null);
      setHistory([]);
      setWeekRows([]);
      setErr(e?.message || 'Failed to load progress');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isActive) return;
    load();
  }, [userId, isActive]);

  const todayIso = localIsoDate();
  const ranToday = history.some((it) => toIso(toLocalSessionDate(it.started_at)) === todayIso);
  const futureWorkout = nextWorkouts.find((w) => String(w.day) > todayIso) || nextWorkouts[0] || null;
  const nextWorkout = !ranToday && todayWorkout ? todayWorkout : futureWorkout;
  const plannedThisWeekToDate = useMemo(() => {
    if (!data) return 0;
    const v = Number((data as any).planned_week_runs);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }, [data]);
  const ranThisWeekToDate = useMemo(() => {
    if (!data) return 0;
    const v = Number((data as any).completed_week_runs);
    return Number.isFinite(v) ? Math.max(0, v) : 0;
  }, [data]);
  const weekPlanStats = useMemo(() => {
    const currentWeek = weekRows[0];
    if (!currentWeek) {
      return { planned: plannedThisWeekToDate, completed: ranThisWeekToDate };
    }
    const plannedDays = currentWeek.days.filter((d) => d.plannedRun).map((d) => d.dayIso);
    const runDays = currentWeek.days.filter((d) => d.ran).map((d) => d.dayIso);
    return { planned: plannedDays.length, completed: matchPlannedToRuns(plannedDays, runDays, 2) };
  }, [weekRows, plannedThisWeekToDate, ranThisWeekToDate]);
  const plannedThisWeek = weekPlanStats.planned;
  const ranThisWeek = weekPlanStats.completed;
  const onTrackPct = useMemo(() => {
    if (plannedThisWeek > 0) {
      return Math.max(0, Math.min(100, Math.round((ranThisWeek / plannedThisWeek) * 100)));
    }
    return 100;
  }, [plannedThisWeek, ranThisWeek]);
  const onTrackLabel =
    plannedThisWeek <= 0
      ? 'Rest & Recover'
      : ranThisWeek >= plannedThisWeek
      ? 'On Track'
      : ranThisWeek === 0
      ? 'Getting Started'
      : 'Building Momentum';
  const currentStreakWeeks = useMemo(() => {
    let streak = 0;
    for (const w of weekRows) {
      const planned = w.days.filter((d) => d.plannedRun).length;
      if (planned === 0) continue;
      const missed = w.days.some((d) => d.missedPlanned);
      if (missed) break;
      streak += 1;
    }
    return streak;
  }, [weekRows]);
  const nextBestAction = useMemo(() => {
    if (plannedThisWeek <= 0) return 'This week has no planned sessions. Focus on recovery and be ready for your next run.';
    const remaining = Math.max(0, plannedThisWeek - ranThisWeek);
    if (remaining <= 0) return 'Great week. Keep momentum by completing your next scheduled workout.';
    return `Complete ${remaining} more ${remaining === 1 ? 'run' : 'runs'} by Sunday to stay on track.`;
  }, [plannedThisWeek, ranThisWeek]);

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Progress</Text>
        <Text style={styles.heroTitle}>Track Your Progress</Text>
      </View>
      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Progress'}</Text>
      </Pressable>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {data ? (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your Progress</Text>
            {weekRows.map((w) => (
              <WeekDots key={w.title} title={w.title} subtitle={w.subtitle} days={w.days} />
            ))}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Next Workout</Text>
            {nextWorkout ? (
              <Pressable onPress={() => setShowNextDetails((v) => !v)} style={styles.nextWorkoutBox}>
                <View style={styles.nextWorkoutHead}>
                  <Text style={styles.nextWorkoutTitle}>{nextWorkout.session_type}</Text>
                  <Text style={styles.nextWorkoutHint}>{showNextDetails ? 'Tap to collapse' : 'Tap for details'}</Text>
                </View>
                <Text style={styles.meta}>
                  {formatDay(nextWorkout.day)} •{' '}
                  {isC25KSession(nextWorkout)
                    ? `${nextWorkout.total_motion_min ? `${nextWorkout.total_motion_min} min motion` : 'Guided run/walk'}`
                    : `${nextWorkout.planned_km} km${nextWorkout.total_motion_min ? ` • ${nextWorkout.total_motion_min} min motion` : ''}`}
                </Text>
                {showNextDetails ? (
                  <View style={styles.nextWorkoutDetails}>
                    <Text style={styles.nextWorkoutDetailsTitle}>Session Breakdown</Text>
                    <Text style={styles.meta}>{workoutSummary(nextWorkout)}</Text>
                  </View>
                ) : null}
              </Pressable>
            ) : (
              <Text style={styles.meta}>No workout scheduled yet.</Text>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Plan Progress</Text>
            <View style={styles.trackHeader}>
              <Text style={styles.trackLabel}>{onTrackLabel}</Text>
              <Text style={styles.trackValue}>{onTrackPct}%</Text>
            </View>
            <Text style={styles.trackSub}>
              {plannedThisWeek > 0
                ? `You completed ${ranThisWeek} of ${plannedThisWeek} planned sessions this week.`
                : 'No planned sessions this week.'}
            </Text>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${onTrackPct}%` }]} />
            </View>
            <View style={styles.sep} />
            <Stat
              label="Sessions done (this week)"
              value={plannedThisWeek > 0 ? `${ranThisWeek}/${plannedThisWeek}` : `${ranThisWeek}`}
            />
            <Stat label="Current streak" value={`${currentStreakWeeks} ${currentStreakWeeks === 1 ? 'week' : 'weeks'}`} />
            <View style={styles.nextActionBox}>
              <Text style={styles.nextActionTitle}>Next best action</Text>
              <Text style={styles.meta}>{nextBestAction}</Text>
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Totals</Text>
            <Stat label="Time in motion (week)" value={`${data.week_motion_min} min`} />
            <Stat label="Distance (week)" value={`${data.week_distance_km} km`} />
            <Stat label="Distance (all-time)" value={`${data.total_distance_km} km`} />
            <Text style={styles.meta}>Week starts: {data.week_start}</Text>
          </View>
        </>
      ) : (
        <Text style={styles.p}>No progress loaded.</Text>
      )}
    </ScrollView>
  );
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function workoutSummary(w: MobileUpcomingWorkout): string {
  const interval = w.interval || null;
  if (!interval) return w.notes || `${w.session_type} • ${w.planned_km} km`;
  const warmup = Number(interval.warmup || 5);
  const run = Number(interval.run || 0);
  const walk = Number(interval.walk || 0);
  const repeats = Number(interval.repeats || 0);
  const cooldown = Number(interval.cooldown || 5);
  const motion = Math.round(warmup + cooldown + (run + walk) * repeats);
  return `${warmup} min warm-up • ${repeats} x (${run} min run / ${walk} min walk) • ${cooldown} min cool-down • ${motion} min motion`;
}

function localIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function WeekDots({
  title,
  subtitle,
  days,
}: {
  title: string;
  subtitle: string;
  days: WeekStatus[];
}) {
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

  return (
    <View style={styles.weekWrap}>
      <View style={styles.weekHeadInline}>
        <Text style={styles.weekTitle}>{title}</Text>
        <Text style={styles.weekSubInline}>• {subtitle}</Text>
      </View>
      <View style={styles.dotRow}>
        {days.map((d, idx) => {
          const plannedUpcoming = d.plannedRun && !d.ran && !d.missedPlanned;
          return (
            <View
              key={`${title}-${d.dayIso}`}
              style={[
                styles.dot,
                d.ran
                  ? d.plannedRun
                    ? styles.dotDonePlanned
                    : styles.dotDoneExtra
                  : d.missedPlanned
                  ? styles.dotMissedPlanned
                  : plannedUpcoming
                  ? styles.dotPlanned
                  : styles.dotNeutral,
              ]}
            >
              <Text
                style={[
                  styles.dotText,
                  d.ran
                    ? d.plannedRun
                      ? styles.dotTextDonePlanned
                      : styles.dotTextDoneExtra
                    : d.missedPlanned
                    ? styles.dotTextMissedPlanned
                    : plannedUpcoming
                    ? styles.dotTextPlanned
                    : styles.dotTextNeutral,
                ]}
              >
                {labels[idx]}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function isC25KSession(w: MobileUpcomingWorkout): boolean {
  const sessionType = String(w.session_type || '').toLowerCase();
  if (sessionType.includes('c25k')) return true;
  const notes = String(w.notes || '');
  if (notes.startsWith('C25K|')) return true;
  if (w.interval && w.interval.run && w.interval.walk) return true;
  return false;
}

function startOfWeekMonday(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  const jsDay = out.getDay();
  const mondayOffset = (jsDay + 6) % 7;
  out.setDate(out.getDate() - mondayOffset);
  return out;
}

function isoDayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map((v) => Number(v));
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function matchPlannedToRuns(plannedDays: string[], runDays: string[], graceDays = 2): number {
  const sortedPlan = [...plannedDays].sort();
  const sortedRuns = [...runDays].sort();
  const used = new Array(sortedRuns.length).fill(false);
  let completed = 0;
  for (const planDay of sortedPlan) {
    const planNum = isoDayNumber(planDay);
    let matched = -1;
    for (let i = 0; i < sortedRuns.length; i += 1) {
      if (used[i]) continue;
      const runNum = isoDayNumber(sortedRuns[i]);
      if (runNum >= planNum && runNum <= planNum + graceDays) {
        matched = i;
        break;
      }
    }
    if (matched >= 0) {
      used[matched] = true;
      completed += 1;
    }
  }
  return completed;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toLocalSessionDate(value: string): Date {
  const hasTimezone = /(?:Z|[+\-]\d{2}:\d{2})$/.test(value);
  const parsed = hasTimezone ? new Date(value) : new Date(`${value}Z`);
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0);
}

async function loadWeekStatuses(userId: number, historyItems: MobileHistoryItem[], startDateIso: string) {
  const today = new Date();
  const todayIso = toIso(today);
  const startDate = parseIsoDate(startDateIso) || today;
  const startIso = toIso(startDate);
  const runDaySet = new Set<string>();
  for (const r of historyItems) {
    const d = toLocalSessionDate(r.started_at);
    runDaySet.add(toIso(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0)));
  }

  const currentWeekStart = startOfWeekMonday(today);
  const startWeekStart = startOfWeekMonday(startDate);
  const weekCount = Math.max(
    1,
    Math.floor((isoDayNumber(toIso(currentWeekStart)) - isoDayNumber(toIso(startWeekStart))) / 7) + 1
  );
  const allDates: string[] = [];
  for (let w = 0; w < weekCount; w++) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekStart);
      d.setDate(currentWeekStart.getDate() - w * 7 + i);
      allDates.push(toIso(d));
    }
  }

  const uniqueDates = Array.from(new Set(allDates));
  const planEntries = await Promise.all(
    uniqueDates.map(async (day) => {
      const res = await getPlanToday(userId, day).catch(() => null);
      const sessionType = String(res?.session_type || '').toLowerCase();
      return {
        day,
        plannedRun: !!res && sessionType !== 'rest',
      };
    })
  );
  const planMap = new Map(planEntries.map((p) => [p.day, p.plannedRun]));

  const rows: Array<{ title: string; subtitle: string; days: WeekStatus[] }> = [];
  for (let w = 0; w < weekCount; w++) {
    const weekDays: WeekStatus[] = [];
    const weekStart = new Date(currentWeekStart);
    weekStart.setDate(currentWeekStart.getDate() - w * 7);
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      const iso = toIso(d);
      const ran = runDaySet.has(iso);
      const planned = iso >= startIso && !!planMap.get(iso);
      const missedPlanned = planned && !ran && iso < todayIso;
      weekDays.push({ dayIso: iso, ran, plannedRun: planned, missedPlanned });
    }
    const weekNum = weekCount - w;
    rows.push({
      title: `Week ${weekNum}`,
      subtitle: `Week commencing ${formatShortDate(toIso(weekStart))}`,
      days: weekDays,
    });
  }
  return rows;
}

function parseIsoDate(value: string): Date | null {
  const parts = value.split('-').map((v) => Number(v));
  if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return null;
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function formatShortDate(dayIso: string): string {
  const d = new Date(`${dayIso}T00:00:00`);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  content: { gap: theme.space.md, paddingBottom: 28 },
  hero: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    gap: 4,
    ...shadow,
  },
  eyebrow: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 12, letterSpacing: 0.3 },
  heroTitle: { fontWeight: '800', fontSize: 20, color: theme.colors.text },
  refresh: { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, padding: 12, alignItems: 'center' },
  refreshText: { color: theme.colors.accentText, fontWeight: '700' },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 10,
    ...shadow,
  },
  cardTitle: { color: theme.colors.text, fontWeight: '800', fontSize: 16 },
  nextWorkoutTitle: { color: theme.colors.accent, fontWeight: '800', fontSize: 18 },
  nextWorkoutHead: { gap: 3 },
  nextWorkoutHint: { color: theme.colors.textMuted, fontSize: 11, fontWeight: '600' },
  nextWorkoutBox: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 10,
    gap: 6,
  },
  nextWorkoutDetails: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 8,
    gap: 4,
  },
  nextWorkoutDetailsTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  sep: { height: 1, backgroundColor: theme.colors.border },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statLabel: { color: theme.colors.textMuted },
  statValue: { fontWeight: '700', color: theme.colors.text },
  trackHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  trackLabel: { color: theme.colors.text, fontWeight: '800', fontSize: 20 },
  trackValue: { color: theme.colors.accent, fontWeight: '800', fontSize: 24 },
  trackSub: { color: theme.colors.textMuted, fontSize: 13 },
  progressTrack: { height: 8, borderRadius: 999, backgroundColor: theme.colors.surfaceAlt, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 999, backgroundColor: theme.colors.accent },
  nextActionBox: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surfaceAlt,
    padding: 10,
    gap: 4,
  },
  nextActionTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  weekWrap: { gap: 8 },
  weekHeadInline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  weekTitle: { color: theme.colors.text, fontWeight: '700' },
  weekSubInline: { color: theme.colors.textMuted, fontSize: 12, fontWeight: '600' },
  dotRow: { flexDirection: 'row', gap: 8 },
  dot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  dotDonePlanned: { backgroundColor: theme.colors.success, borderColor: '#0c7b48', borderWidth: 2.2 },
  dotDoneExtra: { backgroundColor: theme.colors.successSoft, borderColor: theme.colors.successBorder, borderWidth: 1.4 },
  dotMissedPlanned: { backgroundColor: '#fde8e8', borderColor: '#f5a5a5' },
  dotPlanned: { backgroundColor: '#eaf9fd', borderColor: theme.colors.accent, borderWidth: 2.2 },
  dotNeutral: { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border },
  dotText: { fontSize: 12, fontWeight: '800' },
  dotTextDonePlanned: { color: '#ffffff' },
  dotTextDoneExtra: { color: theme.colors.success },
  dotTextMissedPlanned: { color: '#b42318' },
  dotTextPlanned: { color: theme.colors.accent },
  dotTextNeutral: { color: '#8da0b3' },
  meta: { color: theme.colors.textMuted, fontSize: 12 },
  p: { color: theme.colors.text },
  err: { color: theme.colors.danger },
});
