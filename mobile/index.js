import { registerRootComponent } from 'expo';

// The background-location task must be defined at startup, before any UI renders,
// because iOS can relaunch the app in the background just to deliver locations.
import './src/locationTask';
import App from './src/App';

registerRootComponent(App);
