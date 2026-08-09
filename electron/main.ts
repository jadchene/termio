import { app } from 'electron';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void import('./main/application.js').then(async ({ focusMainWindow, startApp }) => {
    app.on('second-instance', focusMainWindow);
    await startApp();
  }).catch((error) => {
    console.error('Failed to start application:', error);
    app.quit();
  });
}
