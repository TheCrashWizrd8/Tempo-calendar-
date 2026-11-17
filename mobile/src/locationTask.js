import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';

export const LOCATION_TASK = 'tempo-background-location';
const INGEST_KEY = 'tempo.ingestUrl';

export const saveIngestUrl = (url) =>
  url ? SecureStore.setItemAsync(INGEST_KEY, url, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })
      : SecureStore.deleteItemAsync(INGEST_KEY);

// Runs in the background whenever iOS/Android hands us new locations.
TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const url = await SecureStore.getItemAsync(INGEST_KEY, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
  if (!url) return;
  const points = data.locations.map((l) => ({
    lat: l.coords.latitude, lng: l.coords.longitude, acc: l.coords.accuracy, ts: l.timestamp,
  }));
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ points }) });
  } catch {
    // offline: the next batch will carry on; a few missed samples don't hurt the model
  }
});

/** Ask for "Always" permission and start battery-friendly background updates. Returns a status message. */
export async function startBackgroundLocation() {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== 'granted') return 'Location permission was not granted.';
  const bg = await Location.requestBackgroundPermissionsAsync();
  if (bg.status !== 'granted') {
    return 'To learn in the background, set Location to "Always" for Tempo in Settings.';
  }
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return 'ok';
  await Location.startLocationUpdatesAsync(LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,     // ~100 m is plenty to tell library from gym from home
    distanceInterval: 75,                     // only when you've actually moved
    timeInterval: 10 * 60 * 1000,             // Android: at most every 10 min
    deferredUpdatesInterval: 10 * 60 * 1000,  // iOS: batch updates to save battery
    deferredUpdatesDistance: 75,
    pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.Other,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'Tempo is learning your routine',
      notificationBody: 'Used to suggest better study times. Turn off in Insights.',
    },
  });
  return 'ok';
}

export async function stopBackgroundLocation() {
  if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
    await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  }
}
