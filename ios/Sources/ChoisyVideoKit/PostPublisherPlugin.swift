import Capacitor
import Foundation

/// The Capacitor face of the background publisher.
///
/// Every method here is short by design: it hops onto the session's serial queue, asks one
/// question, and answers. Nothing is held in memory that the job depends on, because the job
/// routinely outlives this object and sometimes the whole process.
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

    override public func load() {
        let session = PublisherSession.shared
        session.queue.addOperation { [weak self] in
            guard let self else { return }
            session.attach(emitter: self)
            // A WebView reload builds a fresh plugin instance, so this replay is real rather than
            // theoretical, and `acked` is the only thing that stops it repeating forever.
            session.replayUnacked()
        }
    }

    deinit {
        // Synchronous on purpose: a deinit cannot hand `self` to an escaping closure, and by this
        // point the session's weak reference to us has already been zeroed, so this is the belt to
        // that braces rather than the thing doing the work.
        PublisherSession.shared.detach(self)
    }

    /// The session has no bridge of its own, so every event goes out through here.
    func emit(_ event: String, _ data: [String: Any], retain: Bool) {
        notifyListeners(event, data: data, retainUntilConsumed: retain)
    }

    /* ======================================================================================== */

    @objc func publish(_ call: CAPPluginCall) {
        let session = PublisherSession.shared
        session.queue.addOperation {
            do {
                try session.publish(try PublishModels.parse(call))
                call.resolve()
            } catch let error as PublishRequestError {
                call.reject(error.message, Reject.invalidRequest)
            } catch PublishError.fileMissing(let uploadGuid) {
                call.reject("missing file for \(uploadGuid)", Reject.fileMissing)
            } catch {
                call.reject("\(error)", Reject.invalidRequest)
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard let pendingPostId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            guard let state = session.state(for: pendingPostId) else {
                // The one legal NSNull in the whole module: the contract's return type is
                // `{ state: PublishState | null }`, so an unknown post has to answer with a null
                // rather than an absent key.
                call.resolve(["state": NSNull()])
                return
            }
            call.resolve(["state": state])
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let pendingPostId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            // An unknown id is not an error: cancel is usually the first half of a discard, and the
            // caller has no way of knowing whether a record was ever written.
            session.cancel(pendingPostId: pendingPostId)
            call.resolve()
        }
    }

    @objc func retry(_ call: CAPPluginCall) {
        guard let pendingPostId = required(call) else { return }
        let headers = PublishModels.headers(call.getObject("headers"))
        let session = PublisherSession.shared
        session.queue.addOperation {
            do {
                try session.retry(pendingPostId: pendingPostId, headers: headers)
                call.resolve()
            } catch PublishError.notFound(let id) {
                call.reject("nothing to retry for \(id)", Reject.notFound)
            } catch {
                call.reject("\(error)", Reject.invalidRequest)
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let pendingPostId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            session.clear(pendingPostId: pendingPostId)
            call.resolve()
        }
    }

    /* ======================================================================================== */

    /// Rejects and answers nil when the id is missing, so every caller is one `guard` long. The
    /// message is Android's, and `publish` does not use it: its id check comes out of the parser,
    /// which reports the path (`invalid_request:pendingPostId`) like every other field.
    private func required(_ call: CAPPluginCall) -> String? {
        guard let pendingPostId = call.getString("pendingPostId"), !pendingPostId.isEmpty else {
            call.reject("pendingPostId is required", Reject.invalidRequest)
            return nil
        }
        return pendingPostId
    }
}
