import { useState, useEffect, useRef } from 'react'
import audioFile from './assets/audio/audio.mp3'

// @ts-ignore
import JSMpeg from 'jsmpeg'

interface Device {
  deviceId: string
  label: string
  kind: MediaDeviceKind
}

function App(): React.JSX.Element {
  const [mics, setMics] = useState<Device[]>([])
  const [cameras, setCameras] = useState<Device[]>([])
  const [speakers, setSpeakers] = useState<Device[]>([])

  const [selectedMic, setSelectedMic] = useState<string>('')
  const [selectedCamera, setSelectedCamera] = useState<string>('')
  const [selectedSpeaker, setSelectedSpeaker] = useState<string>('')

  const [rtspUrl, setRtspUrl] = useState<string>('')

  const [showPreview, setShowPreview] = useState(false)
  const [isLoadingDevices, setIsLoadingDevices] = useState(true)
  const [isLoadingCamera, setIsLoadingCamera] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const meterRef = useRef<HTMLMeterElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  
  const streamRef = useRef<MediaStream | null>(null)
  const playerRef = useRef<any>(null)
  
  const audioContextRef = useRef<AudioContext | null>(null)
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const audioProcessorRef = useRef<ScriptProcessorNode | null>(null)

  const getDevices = async () => {
    setIsLoadingDevices(true)
    try {
      try { await navigator.mediaDevices.getUserMedia({ audio: true }) } catch (e) { console.warn('Audio err', e) }
      try { await navigator.mediaDevices.getUserMedia({ video: true }) } catch (e) { console.warn('Video err', e) }

      const devices = await navigator.mediaDevices.enumerateDevices()
      const newMics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== '')
      const newCameras = devices.filter((d) => d.kind === 'videoinput' && d.deviceId !== '')
      const newSpeakers = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== '')

      setMics(newMics)
      // Keep existing RTSP virtual devices
      setCameras(prev => {
        const rtsps = prev.filter(c => c.deviceId.startsWith('rtsp://'))
        return [...rtsps, ...newCameras]
      })
      setSpeakers(newSpeakers)

      if (newMics.length > 0 && !selectedMic) setSelectedMic(newMics[0].deviceId)
      if (newCameras.length > 0 && !selectedCamera) setSelectedCamera(newCameras[0].deviceId)
      if (newSpeakers.length > 0 && !selectedSpeaker) setSelectedSpeaker(newSpeakers[0].deviceId)
    } catch (e) {
      console.error('Error getting devices:', e)
    } finally {
      setIsLoadingDevices(false)
    }
  }

  useEffect(() => {
    getDevices()
    const handleDeviceChange = () => getDevices()
    navigator.mediaDevices.addEventListener('devicechange', handleDeviceChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [])

  useEffect(() => {
    if (showPreview) {
      setIsLoadingCamera(true)
      Promise.all([startCamera(), startMicrophone()]).finally(() => {
        setIsLoadingCamera(false)
      })
    }
  }, [showPreview, selectedCamera, selectedMic])

  useEffect(() => {
    // If we have an audio ref and a selected speaker, attempt to set the sink ID.
    // We add showPreview to dependencies because audioRef is null until showPreview is true.
    if (audioRef.current && selectedSpeaker && showPreview) {
      // @ts-ignore
      if (typeof audioRef.current.setSinkId === 'function') {
        // @ts-ignore
        audioRef.current.setSinkId(selectedSpeaker).catch(console.error)
      }
    }
  }, [selectedSpeaker, showPreview])

  const stopTracks = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }
    if (audioSourceRef.current) {
      audioSourceRef.current.disconnect()
      audioSourceRef.current = null
    }
    if (audioProcessorRef.current) {
      audioProcessorRef.current.disconnect()
      audioProcessorRef.current = null
    }
  }

  const stopRtsp = () => {
    if (playerRef.current) {
      playerRef.current.destroy()
      playerRef.current = null
    }
    // @ts-ignore
    window.electron.ipcRenderer.send('stop-rtsp')
  }

  const startCamera = async () => {
    if (!selectedCamera) return
    
    // Stop any active WebRTC video streams
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream
      stream.getTracks().forEach(t => t.stop())
      videoRef.current.srcObject = null
    }
    
    // Stop any active RTSP streams
    stopRtsp()

    if (selectedCamera.startsWith('rtsp://')) {
      // It's an RTSP stream!
      // Send IPC request to start the transcoding
      // @ts-ignore
      window.electron.ipcRenderer.send('start-rtsp', selectedCamera)
      
      // Wait a tiny bit for the websocket to come up, then create the JSMpeg player
      setTimeout(() => {
        if (canvasRef.current) {
          playerRef.current = new JSMpeg.Player('ws://localhost:9999', {
            canvas: canvasRef.current,
            videoBufferSize: 1024 * 1024 * 4 // 4MB Buffer
          })
        }
      }, 1000)
    } else {
      // Regular WebRTC hardware
      try {
        const constraints = {
          video: { deviceId: { exact: selectedCamera } }
        }
        const stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      } catch (e) {
        console.error(e)
      }
    }
  }

  const startMicrophone = async () => {
    if (!selectedMic) return
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx()
      }
      if (audioContextRef.current.state === 'suspended') {
        await audioContextRef.current.resume()
      }
      
      const constraints = {
        audio: { deviceId: { exact: selectedMic } }
      }
      const stream = await navigator.mediaDevices.getUserMedia(constraints)
      
      if (streamRef.current) stopTracks()
      streamRef.current = stream

      setupSoundMeter(stream)
    } catch (e) {
      console.error(e)
    }
  }

  const setupSoundMeter = (stream: MediaStream) => {
    const context = audioContextRef.current!
    
    if (audioSourceRef.current) audioSourceRef.current.disconnect()
    if (audioProcessorRef.current) audioProcessorRef.current.disconnect()

    const source = context.createMediaStreamSource(stream)
    const processor = context.createScriptProcessor(2048, 1, 1)

    audioSourceRef.current = source
    audioProcessorRef.current = processor

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0)
      let sum = 0.0
      for (let i = 0; i < input.length; ++i) {
        sum += input[i] * input[i]
      }
      const instant = Math.sqrt(sum / input.length)
      if (meterRef.current) {
        meterRef.current.value = instant
      }
    }

    source.connect(processor)
    processor.connect(context.destination)
  }

  const handleAddRtsp = () => {
    if (rtspUrl && rtspUrl.startsWith('rtsp://')) {
      const newRtspDevice: Device = {
        deviceId: rtspUrl,
        label: `RTSP: ${rtspUrl.substring(0, 20)}...`,
        kind: 'videoinput'
      }
      setCameras(prev => [...prev, newRtspDevice])
      setSelectedCamera(rtspUrl)
      setRtspUrl('')
    } else {
      alert("Please enter a valid RTSP URL starting with rtsp://")
    }
  }

  return (
    <>
      <h1 className="text">CAMERA NORA DANISH</h1>

      <div className="av-container">
        {isLoadingDevices ? (
          <div className="loader-container">
            <div className="spinner"></div>
            <div>Loading Devices...</div>
          </div>
        ) : !showPreview ? (
          <div className="actions" style={{ justifyContent: 'center' }}>
            <div className="action">
              <a onClick={() => setShowPreview(true)}>Show A/V preview</a>
            </div>
          </div>
        ) : (
          <>
            {isLoadingCamera ? (
              <div className="loader-container">
                <div className="spinner"></div>
                <div>Starting Camera & Audio...</div>
              </div>
            ) : (
              <div className="av-preview">
                {selectedCamera.startsWith('rtsp://') ? (
                   <canvas ref={canvasRef} style={{ maxWidth: '100%', borderRadius: 8, background: '#000' }}></canvas>
                ) : (
                   <video ref={videoRef} autoPlay muted playsInline></video>
                )}
                <meter ref={meterRef} high={0.35} max={1} value={0}></meter>
              </div>
            )}
            
            <div className="av-devices">
              <div className="device-select">
                <label>Microphone:</label>
                <select value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)}>
                  {mics.length === 0 && <option>Choose microphone</option>}
                  {mics.map(m => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
                </select>
              </div>

              <div className="device-select">
                <label>Camera:</label>
                <select value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)}>
                  {cameras.length === 0 && <option>Choose camera</option>}
                  {cameras.map(c => <option key={c.deviceId} value={c.deviceId}>{c.label}</option>)}
                </select>
              </div>

              {/* RTSP Add input */}
              <div style={{ display: 'flex', gap: 10, marginTop: '-5px', marginBottom: '10px' }}>
                <input 
                  type="text" 
                  placeholder="rtsp://your-camera-url" 
                  value={rtspUrl}
                  onChange={(e) => setRtspUrl(e.target.value)}
                  style={{ flex: 1, padding: 8, borderRadius: 4, background: '#333', color: '#fff', border: 'none' }}
                />
                <button 
                  onClick={handleAddRtsp}
                  style={{ padding: 8, borderRadius: 4, background: 'var(--ev-c-brand)', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                  Add RTSP
                </button>
              </div>

              <div className="device-select">
                <label>Speaker:</label>
                <select value={selectedSpeaker} onChange={(e) => setSelectedSpeaker(e.target.value)}>
                  {speakers.length === 0 && <option>Choose speaker</option>}
                  {speakers.map(s => <option key={s.deviceId} value={s.deviceId}>{s.label}</option>)}
                </select>
              </div>

              <div>
                <audio ref={audioRef} controls loop title="local audio file">
                  <source src={audioFile} type="audio/mp3" />
                  This browser does not support the audio element.
                </audio>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  )
}

export default App
