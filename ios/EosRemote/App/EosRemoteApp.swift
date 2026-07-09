import SwiftUI

@main
struct EosRemoteApp: App {
    var body: some Scene {
        WindowGroup {
            rootScene.eosTheme()
        }
    }

    // `-eosGallery` boots straight into the DEBUG render-gallery (mirrors the pairing-bypass pattern),
    // bypassing pairing so the renderers can be verified offline. MessageRowView needs an AppModel in
    // the environment even in the gallery, so one is supplied.
    @ViewBuilder private var rootScene: some View {
        #if DEBUG
        if CommandLine.arguments.contains("-eosGallery") {
            MessageGalleryView().environmentObject(AppModel())
        } else {
            RootView()
        }
        #else
        RootView()
        #endif
    }
}
