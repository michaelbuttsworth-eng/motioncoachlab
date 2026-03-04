import React, { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View, Pressable, TextInput } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SecureStore from 'expo-secure-store';
import PlanTodayScreen from './screens/PlanTodayScreen';
import LiveRunScreen from './screens/LiveRunScreen';
import ProgressScreen from './screens/ProgressScreen';
import HistoryScreen from './screens/HistoryScreen';
import { authGuest, authMe, clearAuthToken, setAuthToken } from './lib/api';

type Tab = 'plan' | 'run' | 'progress' | 'history';
const TOKEN_KEY = 'mcl_auth_token';
const USER_ID_KEY = 'mcl_user_id';
const USER_NAME_KEY = 'mcl_user_name';
const DEVICE_ID_KEY = 'mcl_device_id';

const APPLE_ENABLED = String(process.env.EXPO_PUBLIC_APPLE_LOGIN_ENABLED || 'false') === 'true';
const GOOGLE_ENABLED = String(process.env.EXPO_PUBLIC_GOOGLE_LOGIN_ENABLED || 'false') === 'true';
const FACEBOOK_ENABLED = String(process.env.EXPO_PUBLIC_FACEBOOK_LOGIN_ENABLED || 'false') === 'true';

export default function App() {
  const [tab, setTab] = useState<Tab>('plan');
  const [userId, setUserId] = useState<number | null>(null);
  const [userName, setUserName] = useState('Runner');
  const [loading, setLoading] = useState(true);
  const [authNameInput, setAuthNameInput] = useState('');
  const [authMsg, setAuthMsg] = useState('');

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
          } catch {
            // Token from another environment (e.g. local API) should force a clean re-login.
            clearAuthToken();
            await SecureStore.deleteItemAsync(TOKEN_KEY);
            await SecureStore.deleteItemAsync(USER_ID_KEY);
            await SecureStore.deleteItemAsync(USER_NAME_KEY);
          }
        }
      } finally {
        setLoading(false);
      }
    };
    boot();
  }, []);

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
    } catch (e: any) {
      setAuthMsg(e?.message || 'Login failed');
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
          <Text style={styles.authSub}>Quick start for pilot testing</Text>

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

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <Text style={styles.title}>MotionCoachLab</Text>
        <View>
          <Text style={styles.userLabel}>{userName}</Text>
          <Text style={styles.userId}>ID {userId}</Text>
        </View>
      </View>

      <View style={styles.tabs}>
        <TabBtn label="Plan" active={tab === 'plan'} onPress={() => setTab('plan')} />
        <TabBtn label="Run" active={tab === 'run'} onPress={() => setTab('run')} />
        <TabBtn label="Progress" active={tab === 'progress'} onPress={() => setTab('progress')} />
        <TabBtn label="History" active={tab === 'history'} onPress={() => setTab('history')} />
      </View>

      <View style={styles.body}>
        {tab === 'plan' && <PlanTodayScreen userId={userId} />}
        {tab === 'run' && <LiveRunScreen userId={userId} />}
        {tab === 'progress' && <ProgressScreen userId={userId} />}
        {tab === 'history' && <HistoryScreen userId={userId} />}
      </View>
    </SafeAreaView>
  );
}

function TabBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable style={[styles.tabBtn, active && styles.tabBtnActive]} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f8ef' },
  safeCenter: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  authWrap: { padding: 20, gap: 10 },
  authSub: { color: '#51654a', marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#adc59b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#ffffff',
  },
  primaryBtn: {
    backgroundColor: '#6b8f41',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700' },
  secondaryBtn: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d7e3cf',
  },
  secondaryBtnText: { color: '#2f4230', fontWeight: '600' },
  disabled: { opacity: 0.55 },
  err: { color: '#a32626' },
  header: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: { fontSize: 24, fontWeight: '700', color: '#19241a' },
  userLabel: { color: '#385038', textAlign: 'right', fontWeight: '700' },
  userId: { color: '#5d7455', textAlign: 'right', fontSize: 12 },
  tabs: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 12 },
  tabBtn: {
    flex: 1,
    backgroundColor: '#d9e7ce',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  tabBtnActive: { backgroundColor: '#6b8f41' },
  tabText: { fontWeight: '600', color: '#29411a' },
  tabTextActive: { color: '#ffffff' },
  body: { flex: 1, padding: 16 },
});
