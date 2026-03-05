import React, { useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { generatePlan, upsertOnboarding, upsertProfile } from '../lib/api';

const GOAL_MODES = ['Prepare for an event', 'Build up to run a distance continuously'];
const GOALS = ['5K', '10K', 'Half', 'Marathon', 'Ultra/Other'];
const LEVELS = ['New', 'Returning', 'Regular'];
const TIME_OPTIONS = ['Up to 30 min', 'Up to 45 min', 'Up to 60 min'];
const DAYS = [2, 3, 4, 5, 6];
const RECENT_RUN_OPTIONS: Array<{ label: string; value: number }> = [
  { label: '0 / week', value: 0 },
  { label: '1 / week', value: 1 },
  { label: '2 / week', value: 2 },
  { label: '3+ / week', value: 3 },
];

export default function OnboardingScreen({
  userId,
  onDone,
}: {
  userId: number;
  onDone: () => void;
}) {
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const [goalMode, setGoalMode] = useState<'Prepare for an event' | 'Build up to run a distance continuously'>('Build up to run a distance continuously');
  const [goal, setGoal] = useState('5K');
  const [goalDate, setGoalDate] = useState('');
  const [startDate, setStartDate] = useState(todayIso);
  const [pickerField, setPickerField] = useState<'goal' | 'start' | null>(null);
  const [pickerDate, setPickerDate] = useState<Date>(new Date());
  const [level, setLevel] = useState('New');
  const [recentRunsPerWeek, setRecentRunsPerWeek] = useState(0);
  const [days, setDays] = useState(3);
  const [timePerRun, setTimePerRun] = useState('Up to 45 min');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const parseIsoDate = (value: string): Date => {
    if (!value) return new Date();
    const d = new Date(`${value}T00:00:00`);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  };

  const toIsoDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const toDisplayDate = (value: string): string => {
    if (!value) return 'Select date';
    const d = parseIsoDate(value);
    return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  };

  const isC25KGoal = goal === '5K' && (goalMode === 'Build up to run a distance continuously' || goalMode === 'Prepare for an event');

  const c25kTiming = (() => {
    if (!isC25KGoal) return null;
    if (recentRunsPerWeek <= 0 || level === 'New') return { hardMinWeeks: 8, recommendedWeeks: 9, profile: 'new' as const };
    if (recentRunsPerWeek <= 2 || level === 'Returning') return { hardMinWeeks: 7, recommendedWeeks: 8, profile: 'returning' as const };
    return { hardMinWeeks: 6, recommendedWeeks: 6, profile: 'regular' as const };
  })();

  const timelineBaseDate = parseIsoDate(startDate);
  const minGoalDateForPicker = (() => {
    if (!c25kTiming) return new Date();
    return new Date(timelineBaseDate.getTime() + (c25kTiming.hardMinWeeks * 7 * 24 * 60 * 60 * 1000));
  })();

  const recommendedGoalDate = (() => {
    if (!c25kTiming) return null;
    return new Date(timelineBaseDate.getTime() + (c25kTiming.recommendedWeeks * 7 * 24 * 60 * 60 * 1000));
  })();

  const goalTimingMessage = (() => {
    if (!c25kTiming || !goalDate) return '';
    const picked = parseIsoDate(goalDate);
    const hard = minGoalDateForPicker;
    if (picked < hard) {
      return `Too soon for a safe Couch-to-5K start. Earliest target date: ${hard.toLocaleDateString('en-AU')}.`;
    }
    if (recommendedGoalDate && picked < recommendedGoalDate) {
      return `Fast timeline selected. We recommend ${c25kTiming.recommendedWeeks} weeks for your current baseline.`;
    }
    return '';
  })();

  const openDatePicker = (field: 'goal' | 'start') => {
    const base = field === 'goal' ? goalDate : (startDate || todayIso);
    setPickerDate(parseIsoDate(base));
    setPickerField(field);
  };

  const closeDatePicker = () => setPickerField(null);

  const onDatePickerChange = (event: DateTimePickerEvent, selected?: Date) => {
    if (!selected) {
      if (Platform.OS === 'android') closeDatePicker();
      return;
    }
    if (Platform.OS === 'android') {
      if (event.type === 'set') {
        const iso = toIsoDate(selected);
        if (pickerField === 'goal') setGoalDate(iso);
        if (pickerField === 'start') setStartDate(iso);
      }
      closeDatePicker();
      return;
    }
    setPickerDate(selected);
  };

  const confirmDatePicker = () => {
    const iso = toIsoDate(pickerDate);
    if (pickerField === 'goal') setGoalDate(iso);
    if (pickerField === 'start') setStartDate(iso);
    closeDatePicker();
  };

  const submit = async () => {
    setSaving(true);
    setErr('');
    try {
      const modeDb = goalMode === 'Prepare for an event' ? 'Event prep' : 'Distance build';
      const dateLabel =
        goalMode === 'Prepare for an event'
          ? 'Event date (YYYY-MM-DD)'
          : 'Target date to run full distance (YYYY-MM-DD)';
      if (!goalDate) {
        setErr(`${dateLabel} is required.`);
        setSaving(false);
        return;
      }
      if (c25kTiming) {
        const picked = parseIsoDate(goalDate);
        if (picked < minGoalDateForPicker) {
          setErr(`Pick a later goal date. Earliest safe date is ${minGoalDateForPicker.toLocaleDateString('en-AU')}.`);
          setSaving(false);
          return;
        }
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
      await generatePlan(userId, 16);
      onDone();
    } catch (e: any) {
      setErr(e?.message || 'Failed to save onboarding');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Set up your plan</Text>
      <Text style={styles.sub}>Quick setup, then we generate your full plan.</Text>

      <Text style={styles.label}>What is your primary goal?</Text>
      <View style={styles.row}>
        {GOAL_MODES.map((v) => (
          <Pick
            key={v}
            text={v}
            selected={goalMode === v}
            onPress={() => setGoalMode(v as 'Prepare for an event' | 'Build up to run a distance continuously')}
          />
        ))}
      </View>

      <Text style={styles.label}>
        {goalMode === 'Prepare for an event' ? 'Event distance' : 'Continuous run distance target'}
      </Text>
      <View style={styles.row}>
        {GOALS.map((v) => (
          <Pick key={v} text={v} selected={goal === v} onPress={() => setGoal(v)} />
        ))}
      </View>

      <Text style={styles.label}>
        {goalMode === 'Prepare for an event'
          ? 'Event date (YYYY-MM-DD)'
          : 'Date you want to run the full distance by'}
      </Text>
      <Pressable style={styles.inputBtn} onPress={() => openDatePicker('goal')}>
        <Text style={styles.inputBtnText}>{toDisplayDate(goalDate)}</Text>
      </Pressable>

      <Text style={styles.label}>Desired start date</Text>
      <View style={styles.row}>
        <Pressable style={styles.inputBtnGrow} onPress={() => openDatePicker('start')}>
          <Text style={styles.inputBtnText}>{toDisplayDate(startDate)}</Text>
        </Pressable>
      </View>

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

      <Text style={styles.label}>Run days per week</Text>
      <View style={styles.row}>
        {DAYS.map((v) => (
          <Pick key={String(v)} text={String(v)} selected={days === v} onPress={() => setDays(v)} />
        ))}
      </View>

      <Text style={styles.label}>Time per run</Text>
      <View style={styles.row}>
        {TIME_OPTIONS.map((v) => (
          <Pick key={v} text={v} selected={timePerRun === v} onPress={() => setTimePerRun(v)} />
        ))}
      </View>

      {err ? <Text style={styles.err}>{err}</Text> : null}
      {goalTimingMessage ? (
        <Text style={goalTimingMessage.startsWith('Too soon') ? styles.err : styles.warn}>{goalTimingMessage}</Text>
      ) : null}

      <Pressable style={styles.cta} onPress={submit} disabled={saving}>
        <Text style={styles.ctaText}>{saving ? 'Saving...' : 'Create My Plan'}</Text>
      </Pressable>

      {pickerField ? (
        <Modal visible transparent animationType="fade" onRequestClose={closeDatePicker}>
          <Pressable style={styles.modalBackdrop} onPress={closeDatePicker}>
            <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
              <Text style={styles.modalTitle}>{pickerField === 'goal' ? 'Pick target date' : 'Pick start date'}</Text>
              <DateTimePicker
                value={pickerDate}
                mode="date"
                display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                onChange={onDatePickerChange}
                minimumDate={pickerField === 'goal' ? minGoalDateForPicker : undefined}
              />
              {Platform.OS === 'ios' ? (
                <View style={styles.modalActions}>
                  <Pressable style={styles.modalBtnSecondary} onPress={closeDatePicker}>
                    <Text style={styles.modalBtnSecondaryText}>Cancel</Text>
                  </Pressable>
                  <Pressable style={styles.modalBtnPrimary} onPress={confirmDatePicker}>
                    <Text style={styles.modalBtnPrimaryText}>Done</Text>
                  </Pressable>
                </View>
              ) : null}
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </View>
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
  wrap: { gap: 10, padding: 16 },
  title: { fontSize: 24, fontWeight: '700', color: '#1e2c1e' },
  sub: { color: '#5a6f54', marginBottom: 6 },
  label: { marginTop: 8, fontWeight: '700', color: '#223422' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inputBtn: {
    borderWidth: 1,
    borderColor: '#bfd4b2',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputBtnGrow: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#bfd4b2',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  inputBtnText: { color: '#223422', fontWeight: '600' },
  pickerWrap: {
    borderWidth: 1,
    borderColor: '#dcead0',
    borderRadius: 10,
    backgroundColor: '#fff',
    padding: 6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.30)',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  modalCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#dae6ce',
  },
  modalTitle: { fontWeight: '700', color: '#223422', marginBottom: 8 },
  modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 8 },
  modalBtnSecondary: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#edf4e7' },
  modalBtnSecondaryText: { color: '#31512a', fontWeight: '700' },
  modalBtnPrimary: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#6b8f41' },
  modalBtnPrimaryText: { color: '#fff', fontWeight: '700' },
  clearBtn: { paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#edf4e7', justifyContent: 'center' },
  clearBtnText: { color: '#31512a', fontWeight: '700' },
  pill: { borderWidth: 1, borderColor: '#bfd4b2', backgroundColor: '#fff', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillOn: { backgroundColor: '#6b8f41', borderColor: '#6b8f41' },
  pillText: { color: '#2c4022', fontWeight: '600' },
  pillTextOn: { color: '#fff' },
  cta: { marginTop: 14, backgroundColor: '#6b8f41', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  ctaText: { color: '#fff', fontWeight: '700' },
  err: { color: '#a32626' },
  warn: { color: '#8a5a00' },
});
