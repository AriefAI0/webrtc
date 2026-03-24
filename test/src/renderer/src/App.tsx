import { useCallback, useEffect, useRef, useState } from 'react'
import audioFile from './assets/audio/audio.mp3'
import {
  calculateRms,
  createJsmpegPlayer,
  destroyPlayer,
  Device,
  ensureMediaPermissionsOnce,
  enumerateDevices,
  isNetworkSource,
  isRtmpSource,
  isRtspSource,
  mergeVirtualAndHardwareCameras,
  normalizeNetworkUrl,
  stopMediaStream,
  toVirtualCameraDevice,
  waitForSocketReady
} from './core/webrtc/mediaCore'

const DISPLAY_COUNT = 4
const EMPTY_SOURCES = Array(DISPLAY_COUNT).fill('')
const EMPTY_LOADING = Array(DISPLAY_COUNT).fill(false)

type NetworkPoolItem = {
  wsUrl: string
  refCount: number
}

type HardwarePoolItem = {
  stream: MediaStream
  refCount: number
}

function App(): React.JSX.Element {
  const [mics, setMics] = useState<Device[]>([])
  const [cameras, setCameras] = useState<Device[]>([])
  const [speakers, setSpeakers] = useState<Device[]>([])

  const [selectedMic, setSelectedMic] = useState<string>('')
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('')
  const [displaySources, setDisplaySources] = useState<string[]>(EMPTY_SOURCES)

  const [rtspUrl, setRtspUrl] = useState<string>('')
  const [rtmpUrl, setRtmpUrl] = useState<string>('')

  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isSwitchingAudio, setIsSwitchingAudio] = useState(false)
  const [tileLoading, setTileLoading] = useState<boolean[]>(EMPTY_LOADING)

  const videoRefs = useRef<(HTMLVideoElement | null)[]>(Array(DISPLAY_COUNT).fill(null))
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>(Array(DISPLAY_COUNT).fill(null))
  const tilePlayersRef = useRef<any[]>(Array(DISPLAY_COUNT).fill(null))
  const tileNetworkSourceRef = useRef<(string | null)[]>(Array(DISPLAY_COUNT).fill(null))
  const tileHardwareSourceRef = useRef<(string | null)[]>(Array(DISPLAY_COUNT).fill(null))
  const tileRunIdRef = useRef<number[]>(Array(DISPLAY_COUNT).fill(0))

  const audioRef = useRef<HTMLAudioElement>(null)
  const meterRef = useRef<HTMLMeterElement>(null)

  const micStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)
  const micRunIdRef = useRef(0)

  const permissionRequestedRef = useRef(false)
  const deviceChangeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const networkPoolRef = useRef<Map<string, NetworkPoolItem>>(new Map())
  const hardwarePoolRef = useRef<Map<string, HardwarePoolItem>>(new Map())
  const networkAcquirePendingRef = useRef<Map<string, Promise<string>>>(new Map())
  const hardwareAcquirePendingRef = useRef<Map<string, Promise<MediaStream>>>(new Map())
  const initialDeviceLoadDoneRef = useRef(false)
  const previousDisplaySourcesRef = useRef<string[]>([...EMPTY_SOURCES])
  const displaySourceBeforeInteractionRef = useRef<string[]>([...EMPTY_SOURCES])
  const displaySourceInteractedRef = useRef<boolean[]>(Array(DISPLAY_COUNT).fill(false))

  const setTileLoadingAt = (index: number, loading: boolean) => {
    setTileLoading((previous) => previous.map((value, idx) => (idx === index ? loading : value)))
  }

  const teardownAudioMeter = () => {
    if (audioSourceRef.current) {
      audioSourceRef.current.disconnect()
      audioSourceRef.current = null
    }
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect()
      audioProcessorRef.current.onaudioprocess = null
      audioProcessorRef.current = null
    }
  }

  const acquireNetworkSource = async (sourceId: string): Promise<string> => {
    const existing = networkPoolRef.current.get(sourceId)
    if (existing) {
      existing.refCount += 1
      return existing.wsUrl
    }

    const pending = networkAcquirePendingRef.current.get(sourceId)
    if (pending) {
      const wsUrl = await pending
      const current = networkPoolRef.current.get(sourceId)
      if (!current) {
        throw new Error(`Network source ${sourceId} was not registered after acquire`)
      }
      current.refCount += 1
      return wsUrl
    }

    const acquirePromise = (async () => {
      const response = await window.electron.ipcRenderer.invoke('acquire-network-stream', sourceId)
      const wsUrl = typeof response === 'string' ? response : response?.wsUrl
      if (!wsUrl) {
        throw new Error(`Could not acquire network stream for ${sourceId}`)
      }

      await waitForSocketReady(wsUrl, 3000, 120)
      networkPoolRef.current.set(sourceId, { wsUrl, refCount: 1 })
      return wsUrl
    })()

    networkAcquirePendingRef.current.set(sourceId, acquirePromise)
    try {
      return await acquirePromise
    } finally {
      networkAcquirePendingRef.current.delete(sourceId)
    }
  }

  const releaseNetworkSource = async (sourceId: string) => {
    const existing = networkPoolRef.current.get(sourceId)
    if (!existing) return

    existing.refCount -= 1
    if (existing.refCount <= 0) {
      networkPoolRef.current.delete(sourceId)
      await window.electron.ipcRenderer.invoke('release-network-stream', sourceId)
    }
  }

  const acquireHardwareSource = async (sourceId: string): Promise<MediaStream> => {
    const existing = hardwarePoolRef.current.get(sourceId)
    if (existing) {
      existing.refCount += 1
      return existing.stream
    }

    const pending = hardwareAcquirePendingRef.current.get(sourceId)
    if (pending) {
      const stream = await pending
      const current = hardwarePoolRef.current.get(sourceId)
      if (!current) {
        throw new Error(`Hardware source ${sourceId} was not registered after acquire`)
      }
      current.refCount += 1
      return stream
    }

    const acquirePromise = (async () => {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: sourceId } }
      })
      hardwarePoolRef.current.set(sourceId, { stream, refCount: 1 })
      return stream
    })()

    hardwareAcquirePendingRef.current.set(sourceId, acquirePromise)
    try {
      return await acquirePromise
    } finally {
      hardwareAcquirePendingRef.current.delete(sourceId)
    }
  }

  const releaseHardwareSource = (sourceId: string) => {
    const existing = hardwarePoolRef.current.get(sourceId)
    if (!existing) return

    existing.refCount -= 1
    if (existing.refCount <= 0) {
      stopMediaStream(existing.stream)
      hardwarePoolRef.current.delete(sourceId)
    }
  }

  const stopTile = async (index: number) => {
    destroyPlayer(tilePlayersRef.current[index])
    tilePlayersRef.current[index] = null

    const networkSource = tileNetworkSourceRef.current[index]
    if (networkSource) {
      tileNetworkSourceRef.current[index] = null
      await releaseNetworkSource(networkSource)
    }

    const hardwareSource = tileHardwareSourceRef.current[index]
    if (hardwareSource) {
      tileHardwareSourceRef.current[index] = null
      releaseHardwareSource(hardwareSource)
    }

    const video = videoRefs.current[index]
    if (video) video.srcObject = null
  }

  const startTile = async (index: number, sourceId: string, runId: number) => {
    await stopTile(index)
    if (!sourceId) return

    if (isNetworkSource(sourceId)) {
      const wsUrl = await acquireNetworkSource(sourceId)
      if (tileRunIdRef.current[index] !== runId) {
        await releaseNetworkSource(sourceId)
        return
      }

      const canvas = canvasRefs.current[index]
      if (!canvas) {
        await releaseNetworkSource(sourceId)
        throw new Error(`Display ${index + 1} canvas was not ready`)
      }

      tilePlayersRef.current[index] = createJsmpegPlayer(canvas, wsUrl)
      tileNetworkSourceRef.current[index] = sourceId
      return
    }

    const stream = await acquireHardwareSource(sourceId)
    if (tileRunIdRef.current[index] !== runId) {
      releaseHardwareSource(sourceId)
      return
    }

    const video = videoRefs.current[index]
    if (!video) {
      releaseHardwareSource(sourceId)
      throw new Error(`Display ${index + 1} video element was not ready`)
    }

    tileHardwareSourceRef.current[index] = sourceId
    video.srcObject = stream
    await video.play().catch(() => undefined)
  }

  const switchTileSource = useCallback((index: number, sourceId: string) => {
    const runId = tileRunIdRef.current[index] + 1
    tileRunIdRef.current[index] = runId
    setTileLoadingAt(index, true)

    startTile(index, sourceId, runId)
      .catch((error) => {
        console.error(`Failed switching display ${index + 1}:`, error)
      })
      .finally(() => {
        if (tileRunIdRef.current[index] === runId) {
          setTileLoadingAt(index, false)
        }
      })
  }, [])

  const stopMicrophone = () => {
    teardownAudioMeter()
    stopMediaStream(micStreamRef.current)
    micStreamRef.current = null
    if (meterRef.current) meterRef.current.value = 0
  }

  const setupSoundMeter = (stream: MediaStream) => {
    const context = audioContextRef.current
    if (!context) return

    teardownAudioMeter()
    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(2048, 1, 1)

    audioSourceRef.current = source
    audioProcessorRef.current = processor

    processor.onaudioprocess = (event) => {
      const instant = calculateRms(event.inputBuffer.getChannelData(0))
      if (meterRef.current) meterRef.current.value = instant
    }

    source.connect(processor)
    processor.connect(context.destination)
  }

  const startMicrophone = async (micId: string) => {
    if (!micId) return

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioCtx()
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume()
    }

    const nextMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: micId } }
    })

    const previousMicStream = micStreamRef.current
    micStreamRef.current = nextMicStream
    stopMediaStream(previousMicStream)
    setupSoundMeter(nextMicStream)
  }

  const refreshDevices = useCallback(async () => {
    const shouldShowInitialLoader = !initialDeviceLoadDoneRef.current
    if (shouldShowInitialLoader) {
      setIsInitialLoading(true)
    }

    try {
      await ensureMediaPermissionsOnce(permissionRequestedRef)
      const { microphones, cameras: hardwareCameras, speakers: availableSpeakers } =
        await enumerateDevices()

      setMics(microphones)
      setSelectedMic((previous) =>
        microphones.some((mic) => mic.deviceId === previous) ? previous : (microphones[0]?.deviceId ?? '')
      )

      setCameras((previous) => {
        const merged = mergeVirtualAndHardwareCameras(previous, hardwareCameras)
        setDisplaySources((previousSources) =>
          previousSources.map((sourceId) =>
            merged.some((camera) => camera.deviceId === sourceId) ? sourceId : (merged[0]?.deviceId ?? '')
          )
        )
        return merged
      })

      setSpeakers(availableSpeakers)
      setSelectedSpeaker((previous) =>
        availableSpeakers.some((speaker) => speaker.deviceId === previous)
          ? previous
          : (availableSpeakers[0]?.deviceId ?? '')
      )
    } catch (error) {
      console.error('Error getting devices:', error)
    } finally {
      if (shouldShowInitialLoader) {
        initialDeviceLoadDoneRef.current = true
        setIsInitialLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    refreshDevices()

    const mediaDevices = navigator.mediaDevices

    const handleDeviceChange = () => {
      if (deviceChangeDebounceRef.current) {
        clearTimeout(deviceChangeDebounceRef.current)
      }
      deviceChangeDebounceRef.current = setTimeout(() => {
        refreshDevices()
      }, 250)
    }

    const toDeviceSignature = (devices: MediaDeviceInfo[]): string =>
      devices
        .filter((device) => device.deviceId !== '')
        .map((device) => `${device.kind}:${device.deviceId}`)
        .sort()
        .join('|')

    let devicePollInterval: ReturnType<typeof setInterval> | null = null
    let isPolling = false
    let lastDeviceSignature = ''

    const pollForDeviceChanges = async () => {
      if (isPolling || !mediaDevices?.enumerateDevices) return
      isPolling = true
      try {
        const devices = await mediaDevices.enumerateDevices()
        const signature = toDeviceSignature(devices)
        if (!lastDeviceSignature) {
          lastDeviceSignature = signature
          return
        }
        if (signature !== lastDeviceSignature) {
          lastDeviceSignature = signature
          handleDeviceChange()
        }
      } catch {
        // Ignore transient enumerateDevices errors while polling.
      } finally {
        isPolling = false
      }
    }

    mediaDevices.addEventListener('devicechange', handleDeviceChange)

    void pollForDeviceChanges()
    devicePollInterval = setInterval(() => {
      void pollForDeviceChanges()
    }, 2000)

    return () => {
      mediaDevices.removeEventListener('devicechange', handleDeviceChange)
      if (devicePollInterval) clearInterval(devicePollInterval)
      if (deviceChangeDebounceRef.current) clearTimeout(deviceChangeDebounceRef.current)

      stopMicrophone()

      for (let index = 0; index < DISPLAY_COUNT; index += 1) {
        destroyPlayer(tilePlayersRef.current[index])
        tilePlayersRef.current[index] = null
        tileNetworkSourceRef.current[index] = null
        tileHardwareSourceRef.current[index] = null
        const video = videoRefs.current[index]
        if (video) video.srcObject = null
      }

      if (audioContextRef.current) {
        audioContextRef.current.close().catch(console.error)
        audioContextRef.current = null
      }

      for (const [sourceId, item] of networkPoolRef.current.entries()) {
        for (let i = 0; i < item.refCount; i += 1) {
          void window.electron.ipcRenderer.invoke('release-network-stream', sourceId)
        }
      }
      networkPoolRef.current.clear()
      networkAcquirePendingRef.current.clear()

      for (const item of hardwarePoolRef.current.values()) {
        stopMediaStream(item.stream)
      }
      hardwarePoolRef.current.clear()
      hardwareAcquirePendingRef.current.clear()
    }
  }, [refreshDevices])

  useEffect(() => {
    if (!(audioRef.current && selectedSpeaker)) return
    // @ts-ignore
    if (typeof audioRef.current.setSinkId === 'function') {
      // @ts-ignore
      audioRef.current.setSinkId(selectedSpeaker).catch(console.error)
    }
  }, [selectedSpeaker])

  useEffect(() => {
    if (!selectedMic) return

    const runId = ++micRunIdRef.current
    setIsSwitchingAudio(true)

    startMicrophone(selectedMic)
      .catch(console.error)
      .finally(() => {
        if (runId === micRunIdRef.current) setIsSwitchingAudio(false)
      })
  }, [selectedMic])

  useEffect(() => {
    if (isInitialLoading) return

    displaySources.forEach((sourceId, index) => {
      if (previousDisplaySourcesRef.current[index] !== sourceId) {
        switchTileSource(index, sourceId)
      }
    })

    previousDisplaySourcesRef.current = [...displaySources]
  }, [displaySources, isInitialLoading, switchTileSource])

  const handleDisplaySourceChange = (index: number, nextSourceId: string) => {
    setDisplaySources((previous) => previous.map((value, idx) => (idx === index ? nextSourceId : value)))
  }

  const handleDisplaySourceInteractionStart = (index: number) => {
    displaySourceBeforeInteractionRef.current[index] = displaySources[index]
    displaySourceInteractedRef.current[index] = true
  }

  const handleDisplaySourceInteractionEnd = (index: number) => {
    if (!displaySourceInteractedRef.current[index]) return
    displaySourceInteractedRef.current[index] = false

    const sourceBefore = displaySourceBeforeInteractionRef.current[index]
    const currentSource = displaySources[index]

    if (sourceBefore && currentSource && sourceBefore === currentSource) {
      switchTileSource(index, currentSource)
    }
  }

  const handleAddRtsp = () => {
    const normalizedUrl = normalizeNetworkUrl(rtspUrl)
    if (!(normalizedUrl && isRtspSource(normalizedUrl))) {
      alert('Please enter a valid RTSP URL starting with rtsp://')
      return
    }

    const newRtspDevice = toVirtualCameraDevice(normalizedUrl)
    setCameras((previous) => {
      if (previous.some((camera) => camera.deviceId === normalizedUrl)) {
        return previous
      }
      return [...previous, newRtspDevice]
    })
    setDisplaySources((previous) => {
      const next = [...previous]
      const firstEmptyIndex = next.findIndex((sourceId) => !sourceId)
      const targetIndex = firstEmptyIndex >= 0 ? firstEmptyIndex : 0
      next[targetIndex] = normalizedUrl
      return next
    })
    setRtspUrl('')
  }

  const handleAddRtmp = () => {
    const normalizedUrl = normalizeNetworkUrl(rtmpUrl)
    if (!(normalizedUrl && isRtmpSource(normalizedUrl))) {
      alert('Please enter a valid RTMP URL starting with rtmp://')
      return
    }

    const newRtmpDevice = toVirtualCameraDevice(normalizedUrl)
    setCameras((previous) => {
      if (previous.some((camera) => camera.deviceId === normalizedUrl)) {
        return previous
      }
      return [...previous, newRtmpDevice]
    })
    setDisplaySources((previous) => {
      const next = [...previous]
      const firstEmptyIndex = next.findIndex((sourceId) => !sourceId)
      const targetIndex = firstEmptyIndex >= 0 ? firstEmptyIndex : 0
      next[targetIndex] = normalizedUrl
      return next
    })
    setRtmpUrl('')
  }

  if (isInitialLoading) {
    return (
      <div className="loader-container app-loader">
        <div className="spinner"></div>
        <div>Loading devices...</div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <h1 className="text">CAMERA PREVIEW R&D :D</h1>

      <div className="av-container multi">
        <div className="workspace">
          <div className="multi-preview-grid">
            {displaySources.map((sourceId, index) => (
              <div className="display-card" key={`display-${index}`}>
                <div className="display-head">
                  <span>{`Display ${index + 1}`}</span>
                </div>

                <div className="display-frame">
                  {isNetworkSource(sourceId) ? (
                    <canvas
                      ref={(element) => {
                        canvasRefs.current[index] = element
                      }}
                    ></canvas>
                  ) : (
                    <video
                      ref={(element) => {
                        videoRefs.current[index] = element
                      }}
                      autoPlay
                      muted
                      playsInline
                    ></video>
                  )}

                  {tileLoading[index] && (
                    <div className="tile-loader">
                      <div className="spinner"></div>
                      <div>Switching source...</div>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="obs-bottom-bar">
          <div className="source-select-row">
            {displaySources.map((sourceId, index) => (
              <div className="bottom-select-group" key={`source-select-${index}`}>
                <label>{`Display ${index + 1}`}</label>
                <select
                  value={sourceId}
                  onChange={(event) => handleDisplaySourceChange(index, event.target.value)}
                  onMouseDown={() => handleDisplaySourceInteractionStart(index)}
                  onFocus={() => handleDisplaySourceInteractionStart(index)}
                  onBlur={() => handleDisplaySourceInteractionEnd(index)}
                >
                  {cameras.length === 0 && <option value="">Choose camera</option>}
                  {cameras.map((camera) => (
                    <option key={`${index}-${camera.deviceId}`} value={camera.deviceId}>
                      {camera.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="obs-tools-row">
            <div className="bottom-inline-form">
              <input
                type="text"
                placeholder="rtsp://your-camera-url"
                value={rtspUrl}
                onChange={(e) => setRtspUrl(e.target.value)}
              />
              <button onClick={handleAddRtsp}>Add RTSP</button>
            </div>

            <div className="bottom-inline-form">
              <input
                type="text"
                placeholder="rtmp://your-stream-url"
                value={rtmpUrl}
                onChange={(e) => setRtmpUrl(e.target.value)}
              />
              <button className="rtmp-btn" onClick={handleAddRtmp}>
                Add RTMP
              </button>
            </div>
          </div>

          <div className="audio-controls-row">
            <div className="bottom-select-group">
              <label>Microphone</label>
              <select value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}>
                {mics.length === 0 && <option value="">Choose microphone</option>}
                {mics.map((mic) => (
                  <option key={mic.deviceId} value={mic.deviceId}>
                    {mic.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="meter-group">
              <label>Level</label>
              <meter ref={meterRef} high={0.35} max={1} value={0}></meter>
              {isSwitchingAudio && <span>Switching microphone...</span>}
            </div>

            <div className="bottom-select-group">
              <label>Speaker</label>
              <select value={selectedSpeaker} onChange={(e) => setSelectedSpeaker(e.target.value)}>
                {speakers.length === 0 && <option value="">Choose speaker</option>}
                {speakers.map((speaker) => (
                  <option key={speaker.deviceId} value={speaker.deviceId}>
                    {speaker.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="audio-player-group">
              <audio ref={audioRef} controls loop title="local audio file">
                <source src={audioFile} type="audio/mp3" />
                This browser does not support the audio element.
              </audio>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
