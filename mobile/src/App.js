import { useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import * as WebBrowser from 'expo-web-browser';
import { saveIngestUrl, startBackgroundLocation, stopBackgroundLocation } from './locationTask';

// Set at build time (eas.json -> env) — the public HTTPS address of your Tempo server.
const SERVER = (process.env.EXPO_PUBLIC_SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const SCHEME = 'tempo';

export default function App() {
  const web = useRef(null);
  const [uri, setUri] = useState(SERVER + '/');
  const [failed, setFailed] = useState(false);
  const dark = useColorScheme() === 'dark';

  async function signIn() {
    // Google blocks sign-in inside embedded web views, so use the system auth sheet
    // and come back through tempo://auth?code=...
    const res = await WebBrowser.openAuthSessionAsync(`${SERVER}/auth/google?app=1`, `${SCHEME}://auth`);
    if (res.type !== 'success') return;
    const code = new URL(res.url).searchParams.get('code');
    if (code) setUri(`${SERVER}/auth/app-login?code=${encodeURIComponent(code)}&t=${Date.now()}`);
  }

  async function onMessage(e) {
    let msg;
    try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }
    switch (msg.type) {
      case 'sign-in':
        return signIn();
      case 'signed-in':
      case 'ingest-url':
        return saveIngestUrl(msg.ingestUrl || msg.url);
      case 'signed-out':
        await stopBackgroundLocation();
        return saveIngestUrl(null);
      case 'location':
        if (msg.enabled) {
          const status = await startBackgroundLocation();
          if (status !== 'ok') {
            Alert.alert('Location', status);
            web.current?.injectJavaScript(`document.querySelector('#loc-toggle').checked=false;document.querySelector('#loc-dot').classList.remove('on');try{localStorage.setItem('loc','0')}catch(e){};true;`);
          }
        } else {
          await stopBackgroundLocation();
        }
    }
  }

  if (failed) {
    return (
      <View style={[styles.center, dark && styles.dark]}>
        <Text style={[styles.title, dark && styles.lightText]}>Can't reach Tempo</Text>
        <Text style={styles.muted}>Check your connection and try again.</Text>
        <Pressable style={styles.btn} onPress={() => { setFailed(false); web.current?.reload(); }}>
          <Text style={styles.btnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.flex, { backgroundColor: dark ? '#0f0f14' : '#f7f7fb' }]}>
      <StatusBar style="auto" />
      <WebView
        ref={web}
        source={{ uri }}
        style={styles.flex}
        onMessage={onMessage}
        sharedCookiesEnabled
        allowsBackForwardNavigationGestures
        pullToRefreshEnabled
        startInLoadingState
        renderLoading={() => <ActivityIndicator style={StyleSheet.absoluteFill} />}
        onError={() => setFailed(true)}
        // keep the app on your server; open anything else (e.g. Google Calendar links, maps) in Safari
        onShouldStartLoadWithRequest={(req) => {
          if (req.url.startsWith(SERVER) || req.url.startsWith('about:') || req.url.startsWith('blob:')) return true;
          WebBrowser.openBrowserAsync(req.url);
          return false;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#f7f7fb' },
  dark: { backgroundColor: '#0f0f14' },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 6, color: '#16161d' },
  lightText: { color: '#ececf3' },
  muted: { color: '#6b6b7b', marginBottom: 16 },
  btn: { backgroundColor: '#4f46e5', paddingHorizontal: 22, paddingVertical: 12, borderRadius: 10 },
  btnText: { color: '#fff', fontWeight: '600' },
});
