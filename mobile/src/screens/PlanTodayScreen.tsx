import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  bootstrapProfile,
  generatePlan,
  getHistory,
  getPlanToday,
  getPlanUpcoming,
  getWeeklyAvailability,
  MobilePlanToday,
  MobileUpcomingWorkout,
  setWeeklyAvailability,
} from '../lib/api';
import { shadow, theme } from '../ui/theme';

const WEEK_DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export default function PlanTodayScreen({ userId }: { userId: number }) {
  const [data, setData] = useState<MobilePlanToday | null>(null);
  const [upcoming, setUpcoming] = useState<MobileUpcomingWorkout[]>([]);
  const [todayDone, setTodayDone] = useState(false);
  const [nextWeekAvailability, setNextWeekAvailability] = useState<boolean[]>([false, true, false, true, false, false, true]);
  const [savingAvailability, setSavingAvailability] = useState(false);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const nextWeekStartIso = React.useMemo(() => {
    const now = new Date();
    const mondayIdx = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - mondayIdx);
    monday.setHours(12, 0, 0, 0);
    monday.setDate(monday.getDate() + 7);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  }, []);
  const nextWeekStartLabel = React.useMemo(() => {
    const d = new Date(`${nextWeekStartIso}T00:00:00`);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }, [nextWeekStartIso]);

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      const [res, historyRes, availabilityRes] = await Promise.all([
        getPlanToday(userId),
        getHistory(userId).catch(() => ({ user_id: userId, items: [] })),
        getWeeklyAvailability(userId, nextWeekStartIso).catch(() => null),
      ]);
      setData(res);
      const todayIso = localIsoDate();
      const done = (historyRes.items || []).some((it) => toIso(toLocalSessionDate(it.started_at)) === todayIso);
      setTodayDone(done);
      if (availabilityRes) {
        setNextWeekAvailability([
          availabilityRes.mon,
          availabilityRes.tue,
          availabilityRes.wed,
          availabilityRes.thu,
          availabilityRes.fri,
          availabilityRes.sat,
          availabilityRes.sun,
        ]);
      }
      try {
        const upcomingRes = await getPlanUpcoming(userId, 8, false);
        setUpcoming(
          (upcomingRes.items || []).filter(
            (w) => String(w.day) > todayIso && String(w.session_type || '').toLowerCase() !== 'rest'
          )
        );
      } catch {
        setUpcoming([]);
      }
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (msg.includes('404')) {
        try {
          await generatePlan(userId, 16);
          const [res, upcomingRes] = await Promise.all([
            getPlanToday(userId),
            getPlanUpcoming(userId, 8, false).catch(() => ({ user_id: userId, items: [] })),
          ]);
          setData(res);
          const todayIso = localIsoDate();
          setUpcoming(
            (upcomingRes.items || []).filter(
              (w) => String(w.day) > todayIso && String(w.session_type || '').toLowerCase() !== 'rest'
            )
          );
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setUpcoming([]);
          setErr(retryErr?.message || 'No plan available yet.');
          return;
        }
      }
      if (msg.includes('400') && msg.toLowerCase().includes('profile required')) {
        try {
          await bootstrapProfile(userId);
          await generatePlan(userId, 16);
          const [res, upcomingRes] = await Promise.all([
            getPlanToday(userId),
            getPlanUpcoming(userId, 8, false),
          ]);
          setData(res);
          const todayIso = localIsoDate();
          setUpcoming(
            (upcomingRes.items || []).filter(
              (w) => String(w.day) > todayIso && String(w.session_type || '').toLowerCase() !== 'rest'
            )
          );
          setErr('');
          return;
        } catch (retryErr: any) {
          setData(null);
          setUpcoming([]);
          setErr(retryErr?.message || 'Profile setup failed.');
          return;
        }
      }
      setData(null);
      setUpcoming([]);
      setTodayDone(false);
      setErr(msg || 'Failed to load plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [userId]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <View style={styles.hero}>
        <Text style={styles.eyebrow}>Plan</Text>
        <Text style={styles.heroTitle}>Today&apos;s Plan</Text>
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {data ? (
        <>
          <View style={styles.card}>
            <View style={styles.todayHead}>
              <Text style={styles.h1}>Today: {data.session_type}</Text>
              {todayDone ? (
                <View style={styles.donePill}>
                  <Text style={styles.donePillText}>Completed</Text>
                </View>
              ) : null}
            </View>
            {!isC25KSession(data) ? <Text style={styles.p}>Planned distance: {data.planned_km} km</Text> : null}
            {data.interval ? (
              <>
                <Text style={styles.p}>
                  Guided: {String(data.interval.run || '')} min run / {String(data.interval.walk || '')} min walk, repeats{' '}
                  {String(data.interval.repeats || '')}
                </Text>
                <Text style={styles.notes}>{workoutSummary(data)}</Text>
              </>
            ) : null}
            {data.notes && !String(data.notes).startsWith('C25K|') ? <Text style={styles.notes}>{data.notes}</Text> : null}
          </View>

          {String(data.session_type || '').toLowerCase() === 'rest' && upcoming.length ? (
            <View style={styles.card}>
              <Text style={styles.h1}>Next Run: {formatDay(upcoming[0].day)}</Text>
              <View style={styles.heroWorkoutPill}>
                <Text style={styles.heroWorkoutPillText}>{upcoming[0].session_type}</Text>
              </View>
              <Text style={styles.notes}>{workoutSummary(upcoming[0])}</Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.h1}>Next Week Availability</Text>
            <Text style={styles.notes}>Week commencing {nextWeekStartLabel}. Pick days you can run.</Text>
            <View style={styles.weekRow}>
              {WEEK_DAYS.map((d, i) => (
                <Pressable
                  key={`${d}-${i}`}
                  style={[styles.dayPill, nextWeekAvailability[i] && styles.dayPillOn]}
                  onPress={() => setNextWeekAvailability((prev) => prev.map((v, idx) => (idx === i ? !v : v)))}
                >
                  <Text style={[styles.dayPillText, nextWeekAvailability[i] && styles.dayPillTextOn]}>{d}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              style={[styles.refresh, savingAvailability && styles.disabledBtn]}
              disabled={savingAvailability}
              onPress={async () => {
                const selectedCount = nextWeekAvailability.filter(Boolean).length;
                if (selectedCount === 0) {
                  setErr('Select at least one available day for next week.');
                  return;
                }
                setSavingAvailability(true);
                setErr('');
                try {
                  await setWeeklyAvailability(userId, {
                    week_start: nextWeekStartIso,
                    mon: nextWeekAvailability[0],
                    tue: nextWeekAvailability[1],
                    wed: nextWeekAvailability[2],
                    thu: nextWeekAvailability[3],
                    fri: nextWeekAvailability[4],
                    sat: nextWeekAvailability[5],
                    sun: nextWeekAvailability[6],
                  });
                  await generatePlan(userId, 16);
                  await load();
                } catch (e: any) {
                  setErr(e?.message || 'Could not save next week availability.');
                } finally {
                  setSavingAvailability(false);
                }
              }}
            >
              <Text style={styles.refreshText}>{savingAvailability ? 'Saving...' : 'Save Next Week Plan'}</Text>
            </Pressable>
          </View>

          {upcoming.length ? (
            <View style={styles.card}>
              <Text style={styles.h1}>Upcoming Workouts</Text>
              {upcoming.map((w) => {
                const expanded = expandedDay === w.day;
                return (
                  <Pressable key={w.day} style={styles.upcomingItem} onPress={() => setExpandedDay(expanded ? null : w.day)}>
                    <View style={styles.upcomingHead}>
                      <View style={styles.upcomingDayWrap}>
                        <Text style={styles.upcomingDay}>{formatDay(w.day)}</Text>
                        <Text style={styles.upcomingTapHint}>{expanded ? 'Tap to collapse' : 'Tap to expand'}</Text>
                      </View>
                      <Text style={styles.upcomingType}>{w.session_type}</Text>
                    </View>
                    <Text style={styles.upcomingMeta}>
                      {isC25KSession(w)
                        ? `${w.total_motion_min ? `${w.total_motion_min} min motion` : 'Guided run/walk'}`
                        : `${w.planned_km} km${w.total_motion_min ? ` • ${w.total_motion_min} min motion` : ''}`}
                    </Text>
                    {expanded ? (
                      <View style={styles.detailBox}>
                        <Text style={styles.detailTitle}>Session Breakdown</Text>
                        <Text style={styles.notes}>{workoutSummary(w)}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </>
      ) : (
        <Text style={styles.p}>No plan loaded.</Text>
      )}

      <Pressable onPress={load} style={styles.refresh}>
        <Text style={styles.refreshText}>{loading ? 'Loading...' : 'Refresh Plan'}</Text>
      </Pressable>
    </ScrollView>
  );
}

function localIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toLocalSessionDate(value: string): Date {
  const hasTimezone = /(?:Z|[+\-]\d{2}:\d{2})$/.test(value);
  const parsed = hasTimezone ? new Date(value) : new Date(`${value}Z`);
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0);
}

function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function workoutSummary(w: MobileUpcomingWorkout | MobilePlanToday): string {
  const interval = w.interval || null;
  if (!interval) {
    return w.notes || `${w.session_type} • ${w.planned_km} km`;
  }
  const warmup = Number(interval.warmup || 5);
  const run = Number(interval.run || 0);
  const walk = Number(interval.walk || 0);
  const repeats = Number(interval.repeats || 0);
  const cooldown = Number(interval.cooldown || 5);
  const motion = Math.round(warmup + cooldown + (run + walk) * repeats);
  return `${warmup} min warm-up • ${repeats} x (${run} min run / ${walk} min walk) • ${cooldown} min cool-down • ${motion} min motion`;
}

function isC25KSession(w: MobileUpcomingWorkout | MobilePlanToday): boolean {
  const sessionType = String(w.session_type || '').toLowerCase();
  if (sessionType.includes('c25k')) return true;
  const notes = String(w.notes || '');
  if (notes.startsWith('C25K|')) return true;
  if (w.interval && w.interval.run && w.interval.walk) return true;
  return false;
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  wrap: { gap: theme.space.md },
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
  heroTitle: { fontWeight: '800', fontSize: 22, color: theme.colors.text },
  refresh: { backgroundColor: theme.colors.accent, borderRadius: theme.radius.md, padding: 12, alignItems: 'center' },
  refreshText: { color: theme.colors.accentText, fontWeight: '700' },
  disabledBtn: { opacity: 0.65 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.lg,
    padding: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 8,
    ...shadow,
  },
  h1: { fontWeight: '700', fontSize: 18, color: theme.colors.text },
  todayHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  donePill: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: '#8ad7b5',
    backgroundColor: '#def7ec',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  donePillText: { color: '#118757', fontWeight: '800', fontSize: 11 },
  p: { color: theme.colors.text },
  notes: { color: theme.colors.textMuted, fontSize: 12, lineHeight: 18 },
  sectionEyebrow: { color: theme.colors.textMuted, fontWeight: '700', fontSize: 11, letterSpacing: 0.3 },
  heroWorkoutPill: {
    alignSelf: 'flex-start',
    backgroundColor: theme.colors.accentSoft,
    borderColor: theme.colors.accent,
    borderWidth: 1,
    borderRadius: theme.radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroWorkoutPillText: { color: theme.colors.accent, fontWeight: '800', fontSize: 12 },
  upcomingItem: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    padding: 10,
    gap: 4,
    backgroundColor: theme.colors.surfaceAlt,
  },
  upcomingHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  upcomingDayWrap: { gap: 2 },
  upcomingDay: { color: theme.colors.text, fontWeight: '700' },
  upcomingTapHint: { color: theme.colors.textMuted, fontSize: 11 },
  upcomingType: { color: theme.colors.accent, fontWeight: '700' },
  upcomingMeta: { color: theme.colors.textMuted, fontSize: 12 },
  detailBox: {
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 8,
    gap: 2,
  },
  detailTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
  weekRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
  dayPill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayPillOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  dayPillText: { color: theme.colors.textMuted, fontWeight: '700' },
  dayPillTextOn: { color: theme.colors.accent, fontWeight: '800' },
  err: { color: theme.colors.danger },
});
