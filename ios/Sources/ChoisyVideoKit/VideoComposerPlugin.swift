import Capacitor
import Foundation

/// Placeholder so the iOS project keeps building while the AVFoundation engine is written.
/// Every call rejects with `unimplemented`; `capabilities()` answers honestly instead of throwing
/// so a host can ask before it offers editing at all.
@objc(VideoComposerPlugin)
public class VideoComposerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoComposerPlugin"
    public let jsName = "VideoComposer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumbnails", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise)
    ]

    private static let notYet = "The iOS video composer is not implemented yet."

    @objc func compose(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func cancel(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func getState(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func probe(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func thumbnails(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func startVoiceRecording(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func stopVoiceRecording(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func prepareJob(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func cleanup(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }

    @objc func capabilities(_ call: CAPPluginCall) {
        call.resolve(["supported": false, "reason": Self.notYet])
    }
}
