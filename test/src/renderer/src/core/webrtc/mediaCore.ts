// @ts-ignore
import JSMpeg from 'jsmpeg'

export interface Device {
  deviceId: string
  label: string
  kind: MediaDeviceKind
}

const RTSP_PREFIX = 'rtsp://'
const RTMP_PREFIX = 'rtmp://'

export const isRtspSource = (deviceId: string): boolean => deviceId.startsWith(RTSP_PREFIX)
export const isRtmpSource = (deviceId: string): boolean => deviceId.startsWith(RTMP_PREFIX)
export const isNetworkSource = (deviceId: string): boolean =>
  isRtspSource(deviceId) || isRtmpSource(deviceId)

export const toVirtualCameraDevice = (url: string): Device => ({
  deviceId: url,
  label: `${isRtspSource(url) ? 'RTSP' : 'RTMP'}: ${url.substring(0, 20)}...`,
  kind: 'videoinput'
})

export const mergeVirtualAndHardwareCameras = (
  previousCameras: Device[],
  hardwareCameras: Device[]
): Device[] => {
  const virtual = previousCameras.filter((camera) => isNetworkSource(camera.deviceId))
  const seen = new Set<string>()
  return [...virtual, ...hardwareCameras].filter((camera) => {
    if (seen.has(camera.deviceId)) return false
    seen.add(camera.deviceId)
    return true
  })
}

export const stopMediaStream = (stream: MediaStream | null): void => {
  if (!stream) return
  stream.getTracks().forEach((track) => track.stop())
}

export const calculateRms = (samples: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    sum += samples[i] * samples[i]
  }
  return Math.sqrt(sum / samples.length)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const tryOpenSocket = (url: string, attemptTimeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    let settled = false
    const ws = new WebSocket(url)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      ws.close()
      reject(new Error(`Timeout waiting for ${url}`))
    }, attemptTimeoutMs)

    ws.onopen = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      resolve()
    }

    ws.onerror = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      reject(new Error(`Socket not ready: ${url}`))
    }
  })

export const waitForSocketReady = async (
  url: string,
  timeoutMs = 1800,
  retryEveryMs = 120
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await tryOpenSocket(url, retryEveryMs)
      return
    } catch {
      await sleep(retryEveryMs)
    }
  }
  throw new Error(`Socket did not become ready in time: ${url}`)
}

export const createJsmpegPlayer = (canvas: HTMLCanvasElement, wsUrl: string): any =>
  new JSMpeg.Player(wsUrl, {
    canvas,
    videoBufferSize: 1024 * 1024 * 4
  })

export const destroyPlayer = (player: any): void => {
  if (player && typeof player.destroy === 'function') {
    player.destroy()
  }
}

export const ensureMediaPermissionsOnce = async (flagRef: { current: boolean }): Promise<void> => {
  if (flagRef.current) return

  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    stopMediaStream(audioStream)
  } catch (error) {
    console.warn('Audio permission request failed:', error)
  }

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: true })
    stopMediaStream(videoStream)
  } catch (error) {
    console.warn('Video permission request failed:', error)
  }

  flagRef.current = true
}

export const enumerateDevices = async (): Promise<{
  microphones: Device[]
  cameras: Device[]
  speakers: Device[]
}> => {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    microphones: devices.filter((device) => device.kind === 'audioinput' && device.deviceId !== ''),
    cameras: devices.filter((device) => device.kind === 'videoinput' && device.deviceId !== ''),
    speakers: devices.filter((device) => device.kind === 'audiooutput' && device.deviceId !== '')
  }
}
