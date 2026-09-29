import MetalKit
import QuartzCore

// Drives the First Light shader (FirstLight.metal, compiled at runtime so the
// build needs no Metal toolchain). Ignition, breath and tide run on shader time;
// meteors and the slow whole-scene drift are decided here.
final class FirstLightRenderer: NSObject, MTKViewDelegate {
    // The scene is drawn for a 1440-pt-wide screen; smaller views (the Settings preview) scale it down.
    private static let designWidth: CGFloat = 1440

    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let start = CACurrentMediaTime()
    private var ignition = CACurrentMediaTime()
    private var meteor = Meteor.next(after: 9)

    init?(view: MTKView) {
        guard let device = view.device, let queue = device.makeCommandQueue(),
              let url = Bundle(for: FirstLightRenderer.self).url(forResource: "FirstLight", withExtension: "metal")
        else { return nil }
        do {
            let library = try device.makeLibrary(source: String(contentsOf: url, encoding: .utf8), options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.vertexFunction = library.makeFunction(name: "firstLightVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "firstLightFragment")
            descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            NSLog("Eos saver: First Light shader failed: %@", error.localizedDescription)
            return nil
        }
        self.queue = queue
        super.init()
    }

    // Plays the ignition again: every start of the saver opens with it.
    func ignite() {
        ignition = CACurrentMediaTime()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let commands = queue.makeCommandBuffer(),
              let encoder = commands.makeRenderCommandEncoder(descriptor: pass)
        else { return }
        // Size from the render target itself: view.drawableSize can lag it during a resize.
        let target = CGSize(width: drawable.texture.width, height: drawable.texture.height)
        var uniforms = uniforms(drawable: target, pointsWide: view.bounds.width)
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding()
        commands.present(drawable)
        commands.commit()
    }

    private func uniforms(drawable size: CGSize, pointsWide: CGFloat) -> Uniforms {
        let now = CACurrentMediaTime()
        let time = now - start
        if time > meteor.at + Meteor.lifetime { meteor = Meteor.next(after: time) }
        let age = time - meteor.at
        let points = max(pointsWide, 1)
        let scale = Float(size.width / points * min(1, points / Self.designWidth))
        return Uniforms(
            meteor: (0...Meteor.lifetime).contains(age)
                ? SIMD4(meteor.x, meteor.y, meteor.heading, Float(age))
                : SIMD4(0, 0, 0, -1),
            res: SIMD2(Float(size.width), Float(size.height)),
            drift: SIMD2(6 * Float(sin(time / 47)), 4 * Float(sin(time / 61))) * scale,
            time: Float(time),
            intro: Float(now - ignition),
            scale: scale)
    }
}

// Mirrors `Uniforms` in FirstLight.metal: float4 first, so both sides pack to 48 bytes.
private struct Uniforms {
    var meteor: SIMD4<Float>
    var res: SIMD2<Float>
    var drift: SIMD2<Float>
    var time: Float
    var intro: Float
    var scale: Float
}

// A shooting star every 18–40 s: starts high in the sky and falls at 20–33° to one side.
private struct Meteor {
    static let lifetime = 1.2

    let at: Double
    let x: Float
    let y: Float
    let heading: Float

    static func next(after time: Double) -> Meteor {
        let fallsLeft = Bool.random()
        let tilt = Float.random(in: 0.35...0.57)
        return Meteor(
            at: time + .random(in: 18...40),
            x: fallsLeft ? .random(in: 0.55...0.85) : .random(in: 0.15...0.45),
            y: .random(in: 0.80...0.92),
            heading: fallsLeft ? .pi + tilt : -tilt)
    }
}
