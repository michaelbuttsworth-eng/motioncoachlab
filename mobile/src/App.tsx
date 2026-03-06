import React, { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View, Pressable, TextInput } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import PlanTodayScreen from './screens/PlanTodayScreen';
import LiveRunScreen from './screens/LiveRunScreen';
import ProgressScreen from './screens/ProgressScreen';
import HistoryScreen from './screens/HistoryScreen';
import OnboardingScreen from './screens/OnboardingScreen';
import ProfileScreen from './screens/ProfileScreen';
import { authGuest, authMe, clearAuthToken, getOnboarding, setAuthToken, upsertOnboarding } from './lib/api';
import { shadow, theme } from './ui/theme';

type Tab = 'home' | 'history' | 'run' | 'progress' | 'profile';
const TOKEN_KEY = 'mcl_auth_token';
const USER_ID_KEY = 'mcl_user_id';
const USER_NAME_KEY = 'mcl_user_name';
const DEVICE_ID_KEY = 'mcl_device_id';
const CUE_DETAIL_MODE_KEY = 'mcl_cue_detail_mode_v1';
const BG_MODE_KEY = 'mcl_bg_mode_v1';
const GUIDED_CUES_KEY = 'mcl_guided_cues_v1';
const KEEP_AWAKE_KEY = 'mcl_keep_awake_v1';
const TEST_WARMUP_KEY = 'mcl_test_warmup_min_v1';

const APPLE_ENABLED = String(process.env.EXPO_PUBLIC_APPLE_LOGIN_ENABLED || 'false') === 'true';
const GOOGLE_ENABLED = String(process.env.EXPO_PUBLIC_GOOGLE_LOGIN_ENABLED || 'false') === 'true';
const FACEBOOK_ENABLED = String(process.env.EXPO_PUBLIC_FACEBOOK_LOGIN_ENABLED || 'false') === 'true';

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState('Runner');
  const [loading, setLoading] = useState(true);
  const [authNameInput, setAuthNameInput] = useState('');
  const [authMsg, setAuthMsg] = useState('');
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [cueDetailMode, setCueDetailMode] = useState(true);
  const [backgroundMode, setBackgroundMode] = useState(true);
  const [guidedCuesEnabled, setGuidedCuesEnabled] = useState(true);
  const [keepScreenAwake, setKeepScreenAwake] = useState(false);
  const [testWarmupMin, setTestWarmupMin] = useState<1 | 5>(5);

  useEffect(() => {
    const boot = async () => {
      try {
        const token = await SecureStore.getItemAsync(TOKEN_KEY);
        const uid = await SecureStore.getItemAsync(USER_ID_KEY);
        const nm = await SecureStore.getItemAsync(USER_NAME_KEY);
        if (token && uid) {
          setAuthToken(token);
          try {
            const me = await authMe();
            setUserId(Number(me.user_id));
            setUserName(me.name || nm || 'Runner');
            try {
              const ob = await getOnboarding(Number(me.user_id));
              setNeedsOnboarding(!ob.current_step || Number(ob.current_step) < 99);
            } catch {
              setNeedsOnboarding(true);
            }
          } catch {
            // Token from another environment (e.g. local API) should force a clean re-login.
            clearAuthToken();
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_ID_KEY);
            await SecureStore.deleteItemAsync(USER_NAME_KEY);
          }
        }
        const storedCueDetail = await AsyncStorage.getItem(CUE_DETAIL_MODE_KEY);
        if (storedCueDetail === '0') setCueDetailMode(false);
        const storedBgMode = await AsyncStorage.getItem(BG_MODE_KEY);
        if (storedBgMode === '0') setBackgroundMode(false);
        const storedGuided = await AsyncStorage.getItem(GUIDED_CUES_KEY);
        if (storedGuided === '0') setGuidedCuesEnabled(false);
        const storedKeepAwake = await AsyncStorage.getItem(KEEP_AWAKE_KEY);
        if (storedKeepAwake === '1') setKeepScreenAwake(true);
        const storedWarmup = await AsyncStorage.getItem(TEST_WARMUP_KEY);
        if (storedWarmup === '1') setTestWarmupMin(1);
      } finally {
        setLoading(false);
      }
    };
    boot();
  }, []);

  const setCueDetailModeAndPersist = async (value: boolean) => {
    setCueDetailMode(value);
    try {
      await AsyncStorage.setItem(CUE_DETAIL_MODE_KEY, value ? '1' : '0');
    } catch {
      // ignore local preference save errors
    }
  };
  const setBackgroundModeAndPersist = async (value: boolean) => {
    setBackgroundMode(value);
    try {
      await AsyncStorage.setItem(BG_MODE_KEY, value ? '1' : '0');
    } catch {}
  };
  const setGuidedCuesEnabledAndPersist = async (value: boolean) => {
    setGuidedCuesEnabled(value);
    try {
      await AsyncStorage.setItem(GUIDED_CUES_KEY, value ? '1' : '0');
    } catch {}
  };
  const setKeepScreenAwakeAndPersist = async (value: boolean) => {
    setKeepScreenAwake(value);
    try {
      await AsyncStorage.setItem(KEEP_AWAKE_KEY, value ? '1' : '0');
    } catch {}
  };
  const setTestWarmupMinAndPersist = async (value: 1 | 5) => {
    setTestWarmupMin(value);
    try {
      await AsyncStorage.setItem(TEST_WARMUP_KEY, String(value));
    } catch {}
  };

  const guestLogin = async () => {
    try {
      setAuthMsg('');
      let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
      if (!deviceId) {
        deviceId = `ios-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
      }
      const name = authNameInput.trim() || 'Runner';
      const res = await authGuest(name, deviceId);
      setAuthToken(res.token);
      await SecureStore.setItemAsync(TOKEN_KEY, res.token);
      await SecureStore.setItemAsync(USER_ID_KEY, String(res.user_id));
      await SecureStore.setItemAsync(USER_NAME_KEY, res.name || name);
      setUserId(res.user_id);
      setUserName(res.name || name);
      try {
        const ob = await getOnboarding(res.user_id);
        setNeedsOnboarding(!ob.current_step || Number(ob.current_step) < 99);
      } catch {
        setNeedsOnboarding(true);
      }
    } catch (e: any) {
      setAuthMsg(e?.message || 'Login failed');
    }
  };

  const resetSetup = async () => {
    try {
      await upsertOnboarding(userId!, { current_step: 1 });
      setNeedsOnboarding(true);
    } catch (e: any) {
      setAuthMsg(e?.message || 'Could not reset setup');
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.safeCenter}>
        <Text>Loading...</Text>
      </SafeAreaView>
    );
  }

  if (!userId) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <View style={styles.authWrap}>
          <Text style={styles.title}>MotionCoachLab</Text>
          <Text style={styles.authSub}>Train smart. Build consistency.</Text>

          <TextInput
            style={styles.input}
            value={authNameInput}
            onChangeText={setAuthNameInput}
            placeholder="Your name"
          />

          <Pressable style={styles.primaryBtn} onPress={guestLogin}>
            <Text style={styles.primaryBtnText}>Continue as Guest</Text>
          </Pressable>

          <Pressable style={[styles.secondaryBtn, !APPLE_ENABLED && styles.disabled]} disabled={!APPLE_ENABLED}>
            <Text style={styles.secondaryBtnText}>Continue with Apple (Soon)</Text>
          </Pressable>
          <Pressable style={[styles.secondaryBtn, !GOOGLE_ENABLED && styles.disabled]} disabled={!GOOGLE_ENABLED}>
            <Text style={styles.secondaryBtnText}>Continue with Google (Soon)</Text>
          </Pressable>
          <Pressable style={[styles.secondaryBtn, !FACEBOOK_ENABLED && styles.disabled]} disabled={!FACEBOOK_ENABLED}>
            <Text style={styles.secondaryBtnText}>Continue with Facebook (Soon)</Text>
          </Pressable>

          {authMsg ? <Text style={styles.err}>{authMsg}</Text> : null}
        </View>
      </SafeAreaView>
    );
  }

  if (needsOnboarding) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <OnboardingScreen userId={userId} onDone={() => setNeedsOnboarding(false)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>MotionCoachLab</Text>
          <Text style={styles.subtitle}>Pilot App</Text>
        </View>
        <View>
          <Text style={styles.userLabel}>{userName}</Text>
          <Text style={styles.userId}>ID {userId}</Text>
        </View>
      </View>
      {authMsg ? <Text style={styles.errTop}>{authMsg}</Text> : null}

      <View style={styles.body}>
        {tab === 'home' && <PlanTodayScreen userId={userId} />}
        {tab === 'run' && (
          <LiveRunScreen
            userId={userId}
            backgroundMode={backgroundMode}
            guidedCuesEnabled={guidedCuesEnabled}
            cueDetailMode={cueDetailMode}
            keepScreenAwake={keepScreenAwake}
            testWarmupMin={testWarmupMin}
          />
        )}
        {tab === 'history' && <HistoryScreen userId={userId} />}
        {tab === 'progress' && <ProgressScreen userId={userId} />}
        {tab === 'profile' && (
          <ProfileScreen
            userId={userId}
            userName={userName}
            backgroundMode={backgroundMode}
            onBackgroundModeChange={setBackgroundModeAndPersist}
            guidedCuesEnabled={guidedCuesEnabled}
            onGuidedCuesEnabledChange={setGuidedCuesEnabledAndPersist}
            cueDetailMode={cueDetailMode}
            onCueDetailModeChange={setCueDetailModeAndPersist}
            keepScreenAwake={keepScreenAwake}
            onKeepScreenAwakeChange={setKeepScreenAwakeAndPersist}
            testWarmupMin={testWarmupMin}
            onTestWarmupMinChange={setTestWarmupMinAndPersist}
            onResetSetup={resetSetup}
          />
        )}
      </View>
      <View style={styles.tabs}>
        <TabBtn icon="home" label="Plan" active={tab === 'home'} onPress={() => setTab('home')} />
        <TabBtn icon="progress" label="Progress" active={tab === 'progress'} onPress={() => setTab('progress')} />
        <TabBtn icon="run" label="Run" active={tab === 'run'} onPress={() => setTab('run')} />
        <TabBtn icon="history" label="History" active={tab === 'history'} onPress={() => setTab('history')} />
        <TabBtn icon="profile" label="Settings" active={tab === 'profile'} onPress={() => setTab('profile')} />
      </View>
    </SafeAreaView>
  );
}

function TabBtn({
  icon,
  label,
  active,
  onPress,
}: {
  icon: 'home' | 'history' | 'run' | 'progress' | 'profile';
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={[styles.tabBtn, active && styles.tabBtnActive]} onPress={onPress}>
      <TabIcon name={icon} active={active} />
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function TabIcon({ name, active }: { name: 'home' | 'history' | 'run' | 'progress' | 'profile'; active: boolean }) {
  const stroke = active ? theme.colors.accent : theme.colors.textMuted;
  switch (name) {
    case 'home':
      return (
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke={stroke} strokeWidth={2} />
          <Path d="M8 3V7M16 3V7M4 10H20" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      );
    case 'run':
      return (
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Circle cx="15" cy="5" r="2" fill={stroke} />
          <Path d="M9 12L13 9L16 11L14 14L10 14L8 18" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      );
    case 'history':
      return (
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Rect x="5" y="6" width="14" height="14" rx="2" fill="none" stroke={stroke} strokeWidth={2} />
          <Path d="M8 10H16M8 14H16" stroke={stroke} strokeWidth={2} strokeLinecap="round" />
        </Svg>
      );
    case 'progress':
      return (
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Rect x="4" y="12" width="3" height="8" fill={stroke} />
          <Rect x="10" y="8" width="3" height="12" fill={stroke} />
          <Rect x="16" y="5" width="3" height="15" fill={stroke} />
        </Svg>
      );
    case 'profile':
      return (
        <Svg width={18} height={18} viewBox="0 0 24 24">
          <Circle cx="12" cy="8" r="3" fill="none" stroke={stroke} strokeWidth={2} />
          <Path d="M5 20C6 16 8.5 14.5 12 14.5C15.5 14.5 18 16 19 20" fill="none" stroke={stroke} strokeWidth={2} />
        </Svg>
      );
  }
  return null;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.colors.bg },
  safeCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  authWrap: { padding: 20, gap: theme.space.sm },
  authSub: { color: theme.colors.textMuted, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.radius.md,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: theme.colors.surface,
  },
  primaryBtn: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.radius.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: theme.colors.accentText, fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  secondaryBtnText: { color: theme.colors.text, fontWeight: '600' },
  disabled: { opacity: 0.55 },
  err: { color: theme.colors.danger },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: theme.type.title, fontWeight: '800', color: theme.colors.text },
  subtitle: { color: theme.colors.textMuted, fontSize: theme.type.caption, fontWeight: '600' },
  userLabel: { color: theme.colors.text, textAlign: 'right', fontWeight: '700' },
  userId: { color: theme.colors.textMuted, textAlign: 'right', fontSize: theme.type.caption },
  errTop: { color: theme.colors.danger, paddingHorizontal: 16, paddingBottom: 8 },
  tabs: {
    flexDirection: 'row',
    marginHorizontal: 14,
    marginBottom: 12,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 6,
    ...shadow,
  },
  tabBtn: {
    flex: 1,
    borderRadius: theme.radius.md,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  tabBtnActive: { backgroundColor: theme.colors.accentSoft },
  tabText: { fontWeight: '600', color: theme.colors.textMuted, fontSize: 11 },
  tabTextActive: { color: theme.colors.accent },
  body: { flex: 1, paddingHorizontal: 16, paddingTop: 8 },
});
