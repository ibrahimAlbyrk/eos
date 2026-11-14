import AppKit
import MetalKit
import ScreenSaver

// The Eos screen saver, "First Light": the Eos star as the morning star over a
// still sea at dawn. With "Require password after screen saver begins:
// Immediately" (System Settings › Lock Screen), starting it IS the lock: any
// input brings up macOS's own password prompt.
@objc(EosSaverView)
final class EosSaverView: ScreenSaverView {
    private var scene: MTKView?
    private var renderer: FirstLightRenderer?
    private let clock: SaverClock?

    override init?(frame: NSRect, isPreview: Bool) {
        clock = isPreview ? nil : SaverClock(frame: NSRect(origin: .zero, size: frame.size))
        super.init(frame: frame, isPreview: isPreview)
        wantsLayer = true
        animationTimeInterval = 1.0 / 30.0
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
        if scene == nil { attachScene() }
        renderer?.ignite()
        clock?.restart()
        scene?.isPaused = false
    }

    override func stopAnimation() {
        super.stopAnimation()
        scene?.isPaused = true
    }

    override func animateOneFrame() {
        clock?.tick()
    }

    // Built on the first start, not in init: with several displays the host can
    // put this view in its window before that window is placed on a screen, and a
    // Metal view attached then keeps drawing but never reaches the display. By the
    // time animation starts the window is in place.
    private func attachScene() {
        let scene = MTKView(frame: bounds, device: MTLCreateSystemDefaultDevice())
        scene.colorPixelFormat = .bgra8Unorm
        // The shader writes sRGB; tagging it keeps wide-gamut panels from oversaturating the dawn.
        scene.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        scene.enableSetNeedsDisplay = false
        scene.preferredFramesPerSecond = isPreview ? 30 : 60
        scene.autoresizingMask = [.width, .height]
        let renderer = FirstLightRenderer(view: scene)
        scene.delegate = renderer
        addSubview(scene, positioned: .below, relativeTo: nil)
        self.scene = scene
        self.renderer = renderer
    }

    // legacyScreenSaver (macOS 14+) can outlive the saver without calling
    // stopAnimation, leaving the scene and the clock's timer running for no one.
    @objc private func engineWillStop() {
        stopAnimation()
    }

    override var hasConfigureSheet: Bool { false }
}
