import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { generatePlan, setWeeklyAvailability, upsertOnboarding, upsertProfile } from '../lib/api';
import { theme } from '../ui/theme';

const GOAL_MODES = ['Prepare for an event', 'Build up to run a distance continuously'] as const;
const GOALS = ['5K', '10K', 'Half', 'Marathon', 'Ultra/Other'] as const;
const LEVELS = ['New', 'Returning', 'Regular'] as const;
const TIME_OPTIONS = ['Up to 30 min', 'Up to 45 min', 'Up to 60 min'] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
const RECENT_RUN_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '0 / week', value: 0 },
  { label: '1 / week', value: 1 },
  { label: '2 / week', value: 2 },
  { label: '3+ / week', value: 3 },
];

const MIN_WEEKS_BY_GOAL: Record<(typeof GOALS)[number], { new: number; returning: number; regular: number }> = {
  '5K': { new: 8, returning: 7, regular: 6 },
  '10K': { new: 12, returning: 10, regular: 8 },
  Half: { new: 16, returning: 14, regular: 12 },
  Marathon: { new: 30, returning: 24, regular: 20 },
  'Ultra/Other': { new: 40, returning: 32, regular: 26 },
};

type Step = 1 | 2 | 3 | 4;
type PickerField = 'start' | 'goal' | null;

const isoDayNumber = (iso: string): number => {
  const [y, m, d] = iso.split('-').map((v) => Number(v));
  if (!y || !m || !d) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
};

export default function OnboardingScreen({
  userId,
  onDone,
}: {
  userId: number;
  onDone: () => void;
}) {
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const [step, setStep] = useState<Step>(1);
  const [goalMode, setGoalMode] = useState<(typeof GOAL_MODES)[number]>('Build up to run a distance continuously');
  const [goal, setGoal] = useState<(typeof GOALS)[number]>('5K');
  const [goalDate, setGoalDate] = useState('');
  const [startDate, setStartDate] = useState(todayIso);
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('New');
  const [recentRunsPerWeek, setRecentRunsPerWeek] = useState(0);
  const [days, setDays] = useState<(typeof DAYS)[number]>(3);
  const [timePerRun, setTimePerRun] = useState<(typeof TIME_OPTIONS)[number]>('Up to 45 min');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [goalDateTouched, setGoalDateTouched] = useState(false);
  const [pickerField, setPickerField] = useState<PickerField>(null);
  const [draftDate, setDraftDate] = useState<Date>(new Date());
  const [calendarMonth, setCalendarMonth] = useState<Date>(new Date());
  const [currentWeekAvailability, setCurrentWeekAvailability] = useState<boolean[]>(() => {
    const d = new Date();
    const idx = (d.getDay() + 6) % 7;
    return Array.from({ length: 7 }, (_, i) => i === idx);
  });

  const parseIsoDate = (value: string): Date => {
    if (!value) return new Date();
    const parts = value.split('-').map((v) => Number(v));
    if (parts.length !== 3 || parts.some((p) => Number.isNaN(p))) return new Date();
    const [y, m, d] = parts;
    return new Date(y, m - 1, d, 12, 0, 0, 0);
  };

  const toIsoDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const addDaysIso = (iso: string, daysToAdd: number): string => {
    const [y, m, d] = iso.split('-').map((v) => Number(v));
    const utc = Date.UTC(y, m - 1, d) + daysToAdd * 86400000;
    const next = new Date(utc);
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(
      next.getUTCDate()
    ).padStart(2, '0')}`;
  };

  const toDisplayDate = (value: string): string => {
    if (!value) return 'Select date';
    const d = parseIsoDate(value);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const weekStartIso = useMemo(() => {
    const d = new Date();
    const mondayIdx = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - mondayIdx);
    return toIsoDate(d);
  }, []);

  const todayWeekdayIdx = useMemo(() => {
    const d = new Date();
    return (d.getDay() + 6) % 7;
  }, []);

  const baseline = useMemo<'new' | 'returning' | 'regular'>(() => {
    if (level === 'New' || recentRunsPerWeek <= 0) return 'new';
    if (level === 'Returning' || recentRunsPerWeek <= 2) return 'returning';
    return 'regular';
  }, [level, recentRunsPerWeek]);

  const timeline = useMemo(() => {
    const hardMinWeeks = MIN_WEEKS_BY_GOAL[goal][baseline];
    const recommendedWeeks = hardMinWeeks + (goal === '5K' ? 1 : 2);
    return { hardMinWeeks, recommendedWeeks };
  }, [goal, baseline]);

  const minGoalDateIso = useMemo(
    () => addDaysIso(startDate, timeline.hardMinWeeks * 7),
    [startDate, timeline.hardMinWeeks]
  );
  const recommendedGoalDateIso = useMemo(
    () => addDaysIso(startDate, timeline.recommendedWeeks * 7),
    [startDate, timeline.recommendedWeeks]
  );

  useEffect(() => {
    // Keep default target date realistic for selected distance + fitness baseline.
    if (!goalDate) {
      setGoalDate(recommendedGoalDateIso);
      setGoalDateTouched(false);
      return;
    }
    if (isoDayNumber(goalDate) < isoDayNumber(minGoalDateIso)) {
      setGoalDate(recommendedGoalDateIso);
      setGoalDateTouched(false);
    }
  }, [goal, startDate, level, recentRunsPerWeek, minGoalDateIso, recommendedGoalDateIso]);

  const goalTimingMessage = useMemo(() => {
    if (!goalDate) return '';
    if (isoDayNumber(goalDate) < isoDayNumber(minGoalDateIso)) {
      return `Too soon for a safe timeline. Earliest target date: ${toDisplayDate(minGoalDateIso)}.`;
    }
    if (goalDateTouched && isoDayNumber(goalDate) < isoDayNumber(recommendedGoalDateIso)) {
      return `Aggressive timeline selected. Recommended date: ${toDisplayDate(recommendedGoalDateIso)}.`;
    }
    return '';
  }, [goalDate, minGoalDateIso, recommendedGoalDateIso, goalDateTouched]);

  const openPicker = (field: PickerField) => {
    if (!field) return;
    setPickerField((prev) => {
      const next = prev === field ? null : field;
      if (next) {
        const source = parseIsoDate(next === 'start' ? startDate : goalDate || recommendedGoalDateIso);
        const sourceNoon = new Date(source.getFullYear(), source.getMonth(), source.getDate(), 12, 0, 0, 0);
        setDraftDate(sourceNoon);
        setCalendarMonth(new Date(sourceNoon.getFullYear(), sourceNoon.getMonth(), 1, 12, 0, 0, 0));
      }
      return next;
    });
  };

  const pickerCandidate = (event: DateTimePickerEvent, selected?: Date): Date | null => {
    if (selected instanceof Date && !Number.isNaN(selected.getTime())) {
      return selected;
    }
    const ts = (event as any)?.nativeEvent?.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      const fromTs = new Date(ts);
      if (!Number.isNaN(fromTs.getTime())) {
        return fromTs;
      }
    }
    return null;
  };

  const onStartDateChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === 'android' && event.type !== 'set') {
      setPickerField(null);
      return;
    }
    const candidate = pickerCandidate(event, selected);
    if (!candidate) return;
    setDraftDate(candidate);
    if (Platform.OS === 'android') {
      const picked = toIsoDate(candidate);
      const safePicked = isoDayNumber(picked) >= isoDayNumber(todayIso) ? picked : todayIso;
      setStartDate(safePicked);
      setPickerField(null);
    }
  };

  const onGoalDateChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === 'android' && event.type !== 'set') {
      setPickerField(null);
      return;
    }
    const candidate = pickerCandidate(event, selected);
    if (!candidate) return;
    setDraftDate(candidate);
    if (Platform.OS === 'android') {
      const iso = toIsoDate(candidate);
      if (isoDayNumber(iso) >= isoDayNumber(minGoalDateIso)) {
        setGoalDate(iso);
        setGoalDateTouched(true);
      }
      setPickerField(null);
    }
  };

  const closePicker = () => {
    if (pickerField === 'start') {
      const picked = toIsoDate(draftDate);
      setStartDate(isoDayNumber(picked) >= isoDayNumber(todayIso) ? picked : todayIso);
      setPickerField(null);
      return;
    }
    if (pickerField === 'goal') {
      const picked = toIsoDate(draftDate);
      if (isoDayNumber(picked) >= isoDayNumber(minGoalDateIso)) {
        setGoalDate(picked);
        setGoalDateTouched(true);
      } else {
        setGoalDate(minGoalDateIso);
        setGoalDateTouched(true);
      }
      setPickerField(null);
    }
  };

  const calendarTitle = useMemo(
    () => calendarMonth.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' }),
    [calendarMonth]
  );

  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1, 12, 0, 0, 0);
    const jsDay = firstOfMonth.getDay(); // 0=Sun..6=Sat
    const mondayOffset = (jsDay + 6) % 7;
    const start = new Date(firstOfMonth);
    start.setDate(firstOfMonth.getDate() - mondayOffset);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [calendarMonth]);

  const canNextStep = () => {
    if (step === 1) return !!goalMode && !!goal;
    if (step === 2) return !!goalDate && isoDayNumber(goalDate) >= isoDayNumber(minGoalDateIso);
    if (step === 3) return !!level;
    return true;
  };

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      const modeDb = goalMode === 'Prepare for an event' ? 'Event prep' : 'Distance build';
      if (!goalDate) {
        setErr('Target date is required.');
        setSaving(false);
        return;
      }
      if (isoDayNumber(goalDate) < isoDayNumber(minGoalDateIso)) {
        setErr(`Pick a later target date. Earliest safe date is ${toDisplayDate(minGoalDateIso)}.`);
        setSaving(false);
        return;
      }

      const inferredContinuousMin = level === 'Regular' ? 25 : level === 'Returning' ? 12 : 5;
      await upsertOnboarding(userId, {
        current_step: 99,
        goal_mode: modeDb,
        goal_primary: goal,
        goal_date: goalDate,
        start_date: startDate,
        ability_level: level,
        weekly_availability: days,
        time_per_run: timePerRun,
        recent_runs_per_week: recentRunsPerWeek,
      });
      await upsertProfile(userId, {
        goal_mode: modeDb,
        goal_primary: goal,
        goal_date: goalDate,
        start_date: startDate,
        ability_level: level,
        weekly_availability: days,
        time_per_run: timePerRun,
        injury_status: 'None',
        preferred_days: 'Mon/Tue/Wed/Thu/Fri/Sat/Sun',
        recent_runs_per_week: recentRunsPerWeek,
        longest_recent_min: 0,
        continuous_run_min: inferredContinuousMin,
        run_walk_ok: level === 'Regular' ? 'No' : 'Yes',
      });
      const normalizedAvailability = currentWeekAvailability.map((v, i) => (i < todayWeekdayIdx ? false : v));
      if (!normalizedAvailability.some((v) => v)) {
        normalizedAvailability[todayWeekdayIdx] = true;
      }
      await setWeeklyAvailability(userId, {
        week_start: weekStartIso,
        mon: normalizedAvailability[0],
        tue: normalizedAvailability[1],
        wed: normalizedAvailability[2],
        thu: normalizedAvailability[3],
        fri: normalizedAvailability[4],
        sat: normalizedAvailability[5],
        sun: normalizedAvailability[6],
      });
      try {
        await generatePlan(userId, 16);
      } catch {
        // Do not block onboarding completion if plan generation can be retried later.
      }
      onDone();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save onboarding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.wrap}>
      <Text style={styles.title}>Set up your plan</Text>
      <Text style={styles.sub}>Step {step} of 4</Text>

      <View style={styles.stepBarWrap}>
        {[1, 2, 3, 4].map((n) => (
          <View key={n} style={[styles.stepBar, step >= n ? styles.stepBarOn : null]} />
        ))}
      </View>

      {step === 1 ? (
        <View style={styles.stepCard}>
          <Text style={styles.label}>What is your primary goal?</Text>
          <View style={styles.row}>
            {GOAL_MODES.map((v) => (
              <Pick key={v} text={v} selected={goalMode === v} onPress={() => setGoalMode(v)} />
            ))}
          </View>

          <Text style={styles.label}>{goalMode === 'Prepare for an event' ? 'Event distance' : 'Distance target'}</Text>
          <View style={styles.row}>
            {GOALS.map((v) => (
              <Pick key={v} text={v} selected={goal === v} onPress={() => setGoal(v)} />
            ))}
          </View>
        </View>
      ) : null}

      {step === 2 ? (
        <View style={styles.stepCard}>
          <Text style={styles.label}>Desired start date</Text>
          <Pressable style={styles.dateRow} onPress={() => openPicker('start')}>
            <Text style={styles.dateLabel}>{toDisplayDate(startDate)}</Text>
            <Text style={styles.dateAction}>{pickerField === 'start' ? 'Close' : 'Change'}</Text>
          </Pressable>
          {pickerField === 'start' && Platform.OS === 'android' ? (
            <View style={styles.inlinePicker}>
              <DateTimePicker
                value={parseIsoDate(startDate)}
                mode="date"
                display="default"
                onChange={onStartDateChange}
                minimumDate={parseIsoDate(todayIso)}
              />
            </View>
          ) : null}

          <Text style={styles.label}>
            {goalMode === 'Prepare for an event' ? 'Event date' : 'Date to run full distance by'}
          </Text>
          <Pressable style={styles.dateRow} onPress={() => openPicker('goal')}>
            <Text style={styles.dateLabel}>{toDisplayDate(goalDate)}</Text>
            <Text style={styles.dateAction}>{pickerField === 'goal' ? 'Close' : 'Change'}</Text>
          </Pressable>
          {pickerField === 'goal' && Platform.OS === 'android' ? (
            <View style={styles.inlinePicker}>
              <DateTimePicker
                value={parseIsoDate(goalDate)}
                mode="date"
                display="default"
                onChange={onGoalDateChange}
                minimumDate={parseIsoDate(minGoalDateIso)}
              />
            </View>
          ) : null}

          <Text style={styles.helper}>
            Earliest safe date for {goal}: {toDisplayDate(minGoalDateIso)}
          </Text>
          <Text style={styles.helper}>
            Recommended date: {toDisplayDate(recommendedGoalDateIso)}
          </Text>
        </View>
      ) : null}

      {step === 3 ? (
        <View style={styles.stepCard}>
          <Text style={styles.label}>Current level</Text>
          <View style={styles.row}>
            {LEVELS.map((v) => (
              <Pick key={v} text={v} selected={level === v} onPress={() => setLevel(v)} />
            ))}
          </View>

          <Text style={styles.label}>Recent running (last 4 weeks)</Text>
          <View style={styles.row}>
            {RECENT_RUN_OPTIONS.map((opt) => (
              <Pick
                key={opt.label}
                text={opt.label}
                selected={recentRunsPerWeek === opt.value}
                onPress={() => setRecentRunsPerWeek(opt.value)}
              />
            ))}
          </View>
        </View>
      ) : null}

      {step === 4 ? (
        <View style={styles.stepCard}>
          <Text style={styles.label}>Run days per week</Text>
          <View style={styles.row}>
            {DAYS.map((v) => (
              <Pick
                key={String(v)}
                text={v === 7 ? 'All days' : String(v)}
                selected={days === v}
                onPress={() => setDays(v)}
              />
            ))}
          </View>

          <Text style={styles.label}>Time per run</Text>
          <View style={styles.row}>
            {TIME_OPTIONS.map((v) => (
              <Pick key={v} text={v} selected={timePerRun === v} onPress={() => setTimePerRun(v)} />
            ))}
          </View>

          <Text style={styles.label}>Days available this week</Text>
          <Text style={styles.helper}>Only remaining days are selectable.</Text>
          <View style={styles.weekRow}>
            {WEEKDAY_LABELS.map((day, idx) => {
              const isPast = idx < todayWeekdayIdx;
              const selected = currentWeekAvailability[idx];
              return (
                <Pressable
                  key={day}
                  disabled={isPast}
                  onPress={() =>
                    setCurrentWeekAvailability((prev) => prev.map((v, i) => (i === idx && !isPast ? !v : v)))
                  }
                  style={[styles.dayPill, selected && styles.dayPillOn, isPast && styles.dayPillDisabled]}
                >
                  <Text style={[styles.dayPillText, selected && styles.dayPillTextOn, isPast && styles.dayPillTextDisabled]}>
                    {day[0]}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.summaryBox}>
            <Text style={styles.summaryTitle}>Plan Summary</Text>
            <Text style={styles.summaryText}>
              {goal} target by {toDisplayDate(goalDate)}
            </Text>
            <Text style={styles.summaryText}>
              {days} days/week • {timePerRun}
            </Text>
          </View>
        </View>
      ) : null}

      {goalTimingMessage ? (
        <Text style={goalTimingMessage.startsWith('Too soon') ? styles.err : styles.warn}>{goalTimingMessage}</Text>
      ) : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}

      <View style={styles.actions}>
        {step > 1 ? (
          <Pressable style={styles.backBtn} onPress={() => setStep((s) => (s - 1) as Step)} disabled={saving}>
            <Text style={styles.backBtnText}>Back</Text>
          </Pressable>
        ) : (
          <View style={styles.backPlaceholder} />
        )}

        {step < 4 ? (
          <Pressable style={[styles.cta, !canNextStep() && styles.ctaDisabled]} onPress={() => setStep((s) => (s + 1) as Step)} disabled={!canNextStep()}>
            <Text style={styles.ctaText}>Next</Text>
          </Pressable>
        ) : (
          <Pressable style={[styles.cta, saving && styles.ctaDisabled]} onPress={submit} disabled={saving}>
            <Text style={styles.ctaText}>{saving ? 'Saving...' : 'Create My Plan'}</Text>
          </Pressable>
        )}
      </View>

      {Platform.OS === 'ios' && pickerField ? (
        <Modal transparent animationType="slide" visible onRequestClose={() => setPickerField(null)}>
          <Pressable style={styles.modalBackdrop} onPress={closePicker} />
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {pickerField === 'start' ? 'Desired start date' : 'Date to run full distance by'}
              </Text>
              <Pressable onPress={closePicker} hitSlop={8}>
                <Text style={styles.modalDone}>Done</Text>
              </Pressable>
            </View>
            <Text style={styles.modalSelected}>Selected: {toDisplayDate(toIsoDate(draftDate))}</Text>
            <View style={styles.calendarHeader}>
              <Pressable
                style={styles.monthNav}
                onPress={() => {
                  setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1, 12, 0, 0, 0));
                }}
              >
                <Text style={styles.monthNavText}>‹</Text>
              </Pressable>
              <Text style={styles.calendarTitle}>{calendarTitle}</Text>
              <Pressable
                style={styles.monthNav}
                onPress={() => {
                  setCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1, 12, 0, 0, 0));
                }}
              >
                <Text style={styles.monthNavText}>›</Text>
              </Pressable>
            </View>
            <View style={styles.weekdaysRow}>
              {WEEKDAY_LABELS.map((w) => (
                <Text key={w} style={styles.weekdayLabel}>
                  {w}
                </Text>
              ))}
            </View>
            <View style={styles.calendarGrid}>
              {calendarDays.map((d) => {
                const iso = toIsoDate(d);
                const isCurrentMonth = d.getMonth() === calendarMonth.getMonth();
                const minIso = pickerField === 'goal' ? minGoalDateIso : todayIso;
                const disabled = isoDayNumber(iso) < isoDayNumber(minIso);
                const selected = isoDayNumber(iso) === isoDayNumber(toIsoDate(draftDate));
                return (
                  <Pressable
                    key={iso}
                    style={[
                      styles.dayCell,
                      selected && styles.dayCellSelected,
                      !isCurrentMonth && styles.dayCellOutsideMonth,
                    ]}
                    disabled={disabled}
                    onPress={() => {
                      setDraftDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0));
                    }}
                  >
                    <Text
                      style={[
                        styles.dayCellText,
                        selected && styles.dayCellTextSelected,
                        !isCurrentMonth && styles.dayCellTextOutsideMonth,
                        disabled && styles.dayCellTextDisabled,
                      ]}
                    >
                      {d.getDate()}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={styles.quickRow}>
              <Pressable
                style={styles.quickBtn}
                onPress={() => {
                  const d = new Date(draftDate);
                  d.setDate(d.getDate() - 1);
                  setDraftDate(d);
                  setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0));
                }}
              >
                <Text style={styles.quickBtnText}>-1 day</Text>
              </Pressable>
              <Pressable
                style={styles.quickBtn}
                onPress={() => {
                  const d = new Date(draftDate);
                  d.setDate(d.getDate() + 1);
                  setDraftDate(d);
                  setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0));
                }}
              >
                <Text style={styles.quickBtnText}>+1 day</Text>
              </Pressable>
              <Pressable
                style={styles.quickBtn}
                onPress={() => {
                  const d = new Date();
                  setDraftDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0));
                  setCalendarMonth(new Date(d.getFullYear(), d.getMonth(), 1, 12, 0, 0, 0));
                }}
              >
                <Text style={styles.quickBtnText}>Today</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}

    </ScrollView>
  );
}

function Pick({
  text,
  selected,
  onPress,
}: {
  text: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.pill, selected && styles.pillOn]} onPress={onPress}>
      <Text style={[styles.pillText, selected && styles.pillTextOn]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  wrap: { gap: 10, padding: 16, paddingBottom: 28 },
  title: { fontSize: 24, fontWeight: '700', color: theme.colors.text },
  sub: { color: theme.colors.textMuted, marginBottom: 6, fontWeight: '600' },
  stepBarWrap: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  stepBar: { flex: 1, height: 6, borderRadius: 999, backgroundColor: theme.colors.border },
  stepBarOn: { backgroundColor: theme.colors.accent },
  stepCard: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  label: { marginTop: 4, fontWeight: '700', color: theme.colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dateRow: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  dateLabel: { color: theme.colors.text, fontWeight: '600', flex: 1, paddingRight: 8 },
  dateAction: { color: theme.colors.accent, fontWeight: '700' },
  inlinePicker: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    paddingVertical: 4,
    paddingHorizontal: 6,
    minHeight: Platform.OS === 'android' ? 48 : undefined,
  },
  helper: { color: theme.colors.textMuted, fontSize: 12 },
  weekRow: { flexDirection: 'row', gap: 8, marginTop: 2 },
  dayPill: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceAlt,
  },
  dayPillOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accentSoft },
  dayPillDisabled: { opacity: 0.35 },
  dayPillText: { color: theme.colors.textMuted, fontWeight: '700' },
  dayPillTextOn: { color: theme.colors.accent, fontWeight: '800' },
  dayPillTextDisabled: { color: theme.colors.textMuted },
  summaryBox: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    padding: 10,
    backgroundColor: theme.colors.surfaceAlt,
    gap: 4,
  },
  summaryTitle: { color: theme.colors.text, fontWeight: '800', fontSize: 12 },
  summaryText: { color: theme.colors.textMuted, fontWeight: '600' },
  actions: { marginTop: 10, flexDirection: 'row', gap: 8 },
  backPlaceholder: { flex: 1 },
  backBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: theme.colors.surfaceAlt,
  },
  backBtnText: { color: theme.colors.text, fontWeight: '700' },
  cta: { flex: 1, backgroundColor: theme.colors.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaDisabled: { opacity: 0.55 },
  ctaText: { color: theme.colors.accentText, fontWeight: '700' },
  pill: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  pillOn: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  pillText: { color: theme.colors.text, fontWeight: '600' },
  pillTextOn: { color: theme.colors.accent, fontWeight: '700' },
  err: { color: theme.colors.danger },
  warn: { color: '#8a5a00' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.28)',
  },
  modalCard: {
    backgroundColor: theme.colors.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: 40,
    gap: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalTitle: {
    color: theme.colors.text,
    fontWeight: '700',
    fontSize: 16,
  },
  modalDone: {
    color: theme.colors.accent,
    fontWeight: '700',
    fontSize: 16,
  },
  modalSelected: { color: theme.colors.textMuted, fontWeight: '600' },
  calendarHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  monthNav: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthNavText: { color: theme.colors.accent, fontSize: 24, lineHeight: 24, fontWeight: '700' },
  calendarTitle: { color: theme.colors.text, fontWeight: '700', fontSize: 18 },
  weekdaysRow: { flexDirection: 'row', marginTop: 4 },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  dayCell: {
    width: '14.2857%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
  },
  dayCellSelected: { backgroundColor: theme.colors.accentSoft, borderWidth: 1, borderColor: theme.colors.accent },
  dayCellOutsideMonth: { opacity: 0.38 },
  dayCellText: { color: theme.colors.text, fontWeight: '600' },
  dayCellTextSelected: { color: theme.colors.accent, fontWeight: '800' },
  dayCellTextOutsideMonth: { color: theme.colors.textMuted },
  dayCellTextDisabled: { color: theme.colors.textMuted, opacity: 0.35 },
  quickRow: { flexDirection: 'row', gap: 8 },
  quickBtn: {
    flex: 1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    backgroundColor: theme.colors.surfaceAlt,
    paddingVertical: 10,
    alignItems: 'center',
  },
  quickBtnText: { color: theme.colors.text, fontWeight: '700', fontSize: 12 },
});
