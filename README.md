# Tempo: an AI calendar that learns your routine

Tempo sits on top of **Google Calendar**:

- **📸 Screenshot import:** drop in a class timetable, syllabus, email, flyer or group chat. Claude reads it and proposes events, including weekly repeats for classes and all-day deadlines and exams. You review and edit them before anything is added.
- **📚 Study planner:** finds free time over the next 3–14 days, scores it with your learned habits, and has Claude pick the sessions and assign subjects. It prioritises upcoming exams and deadlines. One tap adds a session to Google Calendar.
- **🧠 Learning from what you actually do:**
  - Location samples are clustered into **places** (home, library, gym…) automatically, and Claude guesses each place's name from the events you had there.
  - Calendar events are auto-categorised (class, study, exercise, social…).
  - A weekly hour-by-hour model learns **when you study**, and **when you're busy even if it's not on your calendar**. For example, it learns that you're at the gym Monday evenings.
  - **Feedback loop:** after a planned session, Tempo checks your location. If you were at the library or home, it counts as done. If you were at the gym, it counts as skipped. If there's no location data, it asks you. Declined suggestions count against that time slot too.

```
server.js            Express API + Google OAuth
src/google.js        Google Calendar access
src/ai.js            Claude: screenshot extraction, categorisation, study planning, place naming
src/learning.js      place clustering, visits, habit model, slot scoring, session verification
public/              the web app (works as an installable PWA on Android/desktop)
mobile/              iOS/Android app (Expo) for TestFlight, with background location
```

## 1. Run the server

Requires Node 22.13 or newer.

1. **Google Cloud Console** (console.cloud.google.com):
   - Create a project.
   - Enable the **Google Calendar API**.
   - Set up the **OAuth consent screen**: External, then add yourself as a **test user**.
   - Go to **Credentials**, then **Create OAuth client ID** of type **Web application**. Add the authorized redirect URI `http://localhost:3000/auth/google/callback`, plus `https://YOUR-DOMAIN/auth/google/callback` once you deploy.
2. **Anthropic API key:** get one at console.anthropic.com.
3. Configure and start:
   ```bash
   cp .env.example .env    # fill it in
   npm install
   npm start               # http://localhost:3000
   ```

**Deploying:** a phone needs a public HTTPS URL. Any Node host with a persistent disk works, such as Render, Railway or Fly.io. Set the same environment variables there, set `BASE_URL=https://your-domain`, and set `ALLOWED_EMAILS` to your Gmail address.

## 2. Ship the iOS app on TestFlight

The app in `mobile/` is a native shell around the web app. It adds:
- **Background location**, using iOS "Always" permission. Updates are battery-friendly: batched, and only sent after you move about 75 m.
- **Google sign-in** in the system browser. Google blocks sign-in inside embedded web views.
- The photo library picker for screenshot import.

You'll need an **Apple Developer account** ($99/yr) and a free **Expo account**. You don't need a Mac: EAS builds and uploads the app in the cloud.

1. In `mobile/app.json`, replace `com.CHANGEME.tempo` with your own bundle ID, for example `com.yourname.tempo`.
2. In `mobile/eas.json`, set `EXPO_PUBLIC_SERVER_URL` to your deployed server URL (HTTPS).
3. Build and upload:
   ```bash
   cd mobile
   npm install
   npx eas-cli@latest login
   npx eas-cli@latest build --platform ios --profile production --auto-submit
   ```
   EAS will ask you to sign in to your Apple account. It creates the certificates and the App Store Connect app, builds the app in the cloud, and submits it to TestFlight.
4. Open App Store Connect, go to your app's **TestFlight** tab, and add yourself under **Internal Testing**. Install the **TestFlight** app on your iPhone and accept the invite. The first build usually takes 10–30 minutes to process.

For later updates, run step 3 again; the build number increments automatically. Internal testers don't need Apple review. External testers (people outside your developer team) need a quick beta review. That review will want a short note explaining why the app uses "Always" location.

After installing, sign in, open **Insights**, and turn on **Learn from my location**. Choose **Allow While Using**. When iOS asks later, choose **Change to Always Allow**.

## Privacy

- Location goes only to your own server, in a local SQLite file. You can delete it any time with **Insights → Delete all location history**.
- Calendar event titles and screenshots are sent to the Claude API for processing.
- The private "ingest link" lets phone automations add location points. Rotate it if it leaks.
