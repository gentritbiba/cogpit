/**
 * The `cogpit/scene` kit module: a Three.js canvas that sizes itself, orbits,
 * pauses off screen and cleans up. Also provides `three` and its orbit
 * controls for views that drive Three.js themselves.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react"
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import { frameApi } from "./frameApi"
import { themeColor } from "./hooks"
import type { ViewTheme } from "../../shared/views/frame"

export interface SceneContext {
  THREE: typeof THREE
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  renderer: THREE.WebGLRenderer
  controls: OrbitControls | null
  /** A theme color as a Three.js color. */
  color: (name: string) => THREE.Color
  /** Called on every theme switch until the scene unmounts. */
  onTheme: (listener: (theme: ViewTheme) => void) => void
}

/** Called each frame with the time and the milliseconds since the last frame. */
type FrameStep = (timeMs: number, deltaMs: number) => void

export interface Scene3DProps {
  /** Runs once: add objects to `scene`. Return a per-frame step, or `{ frame, cleanup }`. */
  setup: (context: SceneContext) => FrameStep | { frame?: FrameStep; cleanup?: () => void } | void
  height?: number
  camera?: [number, number, number]
  controls?: boolean
  /** A soft sky light and a sun, unless you light the scene yourself. */
  lights?: boolean
  className?: string
  style?: CSSProperties
}

export function Scene3D({ setup, height = 320, camera: position = [3, 2, 4], controls = true, lights = true, className, style }: Scene3DProps) {
  const host = useRef<HTMLDivElement>(null)
  const props = useRef({ setup, height, position, controls, lights })
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    const element = host.current!
    const { setup: run, height: tall, position: [cx, cy, cz], controls: orbiting, lights: lit } = props.current
    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      // The browser showing the view has no WebGL: the rest of the view still runs.
      setUnavailable(true)
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    element.append(renderer.domElement)
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000)
    camera.position.set(cx, cy, cz)
    if (lit) {
      scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.4))
      const sun = new THREE.DirectionalLight(0xffffff, 1.6)
      sun.position.set(5, 10, 7)
      scene.add(sun)
    }
    const orbit = orbiting ? new OrbitControls(camera, renderer.domElement) : null
    if (orbit) orbit.enableDamping = true
    const resize = () => {
      const width = Math.max(1, element.clientWidth)
      renderer.setSize(width, tall)
      camera.aspect = width / tall
      camera.updateProjectionMatrix()
    }
    resize()
    const resizes = new ResizeObserver(resize)
    resizes.observe(element)

    const unsubscribe: Array<() => void> = []
    const frame = frameApi()
    let step: FrameStep | undefined
    let cleanup: (() => void) | undefined
    try {
      const result = run({
        THREE, scene, camera, renderer, controls: orbit,
        color: (name) => new THREE.Color(themeColor(name) || name),
        onTheme: (listener) => { if (frame) unsubscribe.push(frame.onTheme(listener)) },
      })
      step = typeof result === "function" ? result : result?.frame
      cleanup = typeof result === "object" && result ? result.cleanup : undefined
    } catch (error) {
      reportError(error)
    }

    let visible = true
    const sight = new IntersectionObserver((entries) => { visible = entries.some((entry) => entry.isIntersecting) })
    sight.observe(element)
    let handle = 0
    let last = performance.now()
    const tick = (now: number) => {
      handle = requestAnimationFrame(tick)
      const delta = now - last
      last = now
      if (!visible) return
      try {
        orbit?.update()
        step?.(now, delta)
        renderer.render(scene, camera)
      } catch (error) {
        cancelAnimationFrame(handle)
        reportError(error)
      }
    }
    handle = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(handle)
      resizes.disconnect()
      sight.disconnect()
      for (const stop of unsubscribe) stop()
      cleanup?.()
      orbit?.dispose()
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        for (const material of ([] as THREE.Material[]).concat(mesh.material ?? [])) material.dispose()
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div ref={host} className={["ck-scene", className].filter(Boolean).join(" ")} style={{ height, ...style }}>
      {unavailable && <p className="muted ck-scene-unavailable">3D needs WebGL, which this browser does not offer.</p>}
    </div>
  )
}

const controlsModule = { OrbitControls }

export const modules = {
  "cogpit/scene": { Scene3D },
  three: THREE,
  "three/addons/controls/OrbitControls.js": controlsModule,
  "three/examples/jsm/controls/OrbitControls.js": controlsModule,
}
