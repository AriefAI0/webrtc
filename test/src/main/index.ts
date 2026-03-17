import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'

// @ts-ignore
const Stream = require('node-rtsp-stream')
// @ts-ignore
const ffmpegPath = require('ffmpeg-static')

type ManagedStream = {
  stream: any
  wsPort: number
  wsUrl: string
  refCount: number
}

const BASE_WS_PORT = 11000
const MAX_WS_PORT = 12999
const LOCAL_WS_HOST = '127.0.0.1'

const managedNetworkStreams = new Map<string, ManagedStream>()
const usedWsPorts = new Set<number>()

const allocateWsPort = (): number => {
  for (let port = BASE_WS_PORT; port <= MAX_WS_PORT; port += 1) {
    if (!usedWsPorts.has(port)) {
      usedWsPorts.add(port)
      return port
    }
  }
  throw new Error('No available websocket ports for network streams')
}

const releaseWsPort = (port: number): void => {
  usedWsPorts.delete(port)
}

const createManagedNetworkStream = (sourceUrl: string): ManagedStream => {
  const wsPort = allocateWsPort()
  const stream = new Stream({
    name: `network-stream-${wsPort}`,
    streamUrl: sourceUrl,
    wsPort,
    ffmpegPath,
    ffmpegOptions: {
      '-stats': '',
      '-r': 30,
      '-fflags': 'nobuffer',
      '-flags': 'low_delay'
    }
  })

  return {
    stream,
    wsPort,
    wsUrl: `ws://${LOCAL_WS_HOST}:${wsPort}`,
    refCount: 1
  }
}

const stopManagedNetworkStream = (sourceUrl: string): void => {
  const managed = managedNetworkStreams.get(sourceUrl)
  if (!managed) return

  try {
    managed.stream.stop()
  } catch (error) {
    console.error(`Failed stopping stream for ${sourceUrl}:`, error)
  } finally {
    releaseWsPort(managed.wsPort)
    managedNetworkStreams.delete(sourceUrl)
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 2880,
    height: 1920,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('acquire-network-stream', (_, sourceUrl: string) => {
    if (!sourceUrl) {
      throw new Error('Source URL is required')
    }

    const existing = managedNetworkStreams.get(sourceUrl)
    if (existing) {
      existing.refCount += 1
      return { wsUrl: existing.wsUrl }
    }

    const created = createManagedNetworkStream(sourceUrl)
    managedNetworkStreams.set(sourceUrl, created)
    return { wsUrl: created.wsUrl }
  })

  ipcMain.handle('release-network-stream', (_, sourceUrl: string) => {
    const existing = managedNetworkStreams.get(sourceUrl)
    if (!existing) {
      return { released: false }
    }

    existing.refCount -= 1
    if (existing.refCount <= 0) {
      stopManagedNetworkStream(sourceUrl)
      return { released: true }
    }

    return { released: false }
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  for (const sourceUrl of [...managedNetworkStreams.keys()]) {
    stopManagedNetworkStream(sourceUrl)
  }

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
