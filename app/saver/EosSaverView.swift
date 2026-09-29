import AppKit
import MetalKit
import ScreenSaver

// The Eos screen saver, "First Light": the Eos star as the morning star over a
// still sea at dawn. With "Require password after screen saver begins:
// Immediately" (System Settings › Lock Screen), starting it IS the lock: any
// input brings up macOS's own password prompt.
@objc(EosSaverView)
final class EosSaverView: ScreenSaverView {
    private let scene: MTKView
    private let renderer: FirstLightRenderer?
    private let clock: SaverClock?

    override init?(frame: NSRect, isPreview: Bool) {
        let scene = MTKView(frame: NSRect(origin: .zero, size: frame.size), device: MTLCreateSystemDefaultDevice())
        scene.colorPixelFormat = .bgra8Unorm
        // The shader writes sRGB; tagging it keeps wide-gamut panels from oversaturating the dawn.
        scene.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        scene.isPaused = true
        scene.enableSetNeedsDisplay = false
        scene.preferredFramesPerSecond = isPreview ? 30 : 60
        scene.autoresizingMask = [.width, .height]
        let renderer = FirstLightRenderer(view: scene)
        scene.delegate = renderer
        self.scene = scene
        self.renderer = renderer
        clock = isPreview ? nil : SaverClock(frame: NSRect(origin: .zero, size: frame.size))
        super.init(frame: frame, isPreview: isPreview)
        wantsLayer = true
        animationTimeInterval = 1.0 / 30.0
        addSubview(scene)
        if let clock {
            clock.autoresizingMask = [.width, .height]
            addSubview(clock)
        }
        if !isPreview {
            DistributedNotificationCenter.default().addObserver(
                self, selector: #selector(engineWillStop), name: Notification.Name("com.apple.screensaver.willstop"), object: nil)
        }
    }

    required init?(coder: NSCoder) { nil }

    deinit {
        DistributedNotificationCenter.default().removeObserver(self)
    }

    override func startAnimation() {
        super.startAnimation()
        renderer?.ignite()
        clock?.restart()
        scene.isPaused = false
    }

    override func stopAnimation() {
        super.stopAnimation()
        scene.isPaused = true
    }

    override func animateOneFrame() {
        clock?.tick()
    }

    // legacyScreenSaver (macOS 14+) can outlive the saver without calling
    // stopAnimation, leaving the scene drawing for no one.
    @objc private func engineWillStop() {
        scene.isPaused = true
    }

    override var hasConfigureSheet: Bool { false }
}
