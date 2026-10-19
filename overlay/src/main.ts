import { getCurrentWindow } from '@tauri-apps/api/window'

// One page serves both windows: the overlay, and the display-area editor the tray opens.
if (getCurrentWindow().label === 'editor') {
  await import('./editor')
} else {
  await import('./overlay')
}
