const { app, BrowserWindow, Menu, shell, dialog, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const PORT = 8787;

// Garante que só uma instância do app rode por vez (evita duas tentando
// ocupar a mesma porta 8787/8788 na mesma máquina).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let mainWindow = null;

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 720,
      minHeight: 520,
      backgroundColor: "#020617",
      icon: path.join(__dirname, "build", "icon.png"),
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        // O local-hub já é nosso próprio código local (não é conteúdo remoto
        // arbitrário), então não precisa de preload/exposição extra de APIs.
      },
    });

    // Abre links "target=_blank" (ex.: convites por WhatsApp) no navegador padrão
    // em vez de dentro da janela do app.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.loadURL(`http://localhost:${PORT}/`);
  }

  async function startLocalHub() {
    // Pasta de dados sempre gravável (fora do app instalado, que é somente
    // leitura no Mac e, em instalações de sistema, no Windows).
    const dataDir = app.getPath("userData");
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.STAGE_HUB_DATA_DIR = dataDir;

    const serverPath = path.join(__dirname, "local-hub", "server.mjs");
    const { ready } = await import(`file://${serverPath}`);
    return ready;
  }

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Por padrão o Electron NEGA pedidos de permissão do navegador (câmera,
    // microfone, MIDI...). O control.html usa Web MIDI para escutar o
    // Logic Pro/DAW via IAC Driver, então precisamos liberar isso aqui.
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(permission === "midi" || permission === "midiSysex" || permission === "microphone");
    });

    try {
      await startLocalHub();
    } catch (error) {
      dialog.showErrorBox(
        "Stage Prompt — erro ao iniciar",
        `Não foi possível iniciar a central local:\n\n${error?.stack || error}`,
      );
      app.quit();
      return;
    }
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
