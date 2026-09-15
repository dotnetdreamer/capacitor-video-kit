import Capacitor
import Foundation

/// Placeholder so the iOS project keeps building while the background `URLSession` transport is
/// written. `getState` answers `null` - the honest "nothing is in flight" - so a caller's reconcile
/// pass runs unchanged; everything else rejects with `unimplemented`.
@objc(PostPublisherPlugin)
public class PostPublisherPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PostPublisherPlugin"
    public let jsName = "PostPublisher"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "publish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retry", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    private static let notYet = "The iOS post publisher is not implemented yet."

    @objc func publish(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func cancel(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func retry(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }
    @objc func clear(_ call: CAPPluginCall) { call.reject(Self.notYet, "unimplemented") }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(["state": NSNull()])
    }
}
