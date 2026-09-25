import Capacitor
import Foundation

/// The Capacitor face of the background publisher.
///
/// Every method here is short by design: it hops onto the session's serial queue, asks one
/// question, and answers. Nothing is held in memory that the job depends on, because the job
/// routinely outlives this object and sometimes the whole process.
@objc(BackgroundPublisherPlugin)
public class BackgroundPublisherPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BackgroundPublisherPlugin"
    public let jsName = "BackgroundPublisher"
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
            // Capacitor loads this plugin once per bridge, not on a web view reload (see
            // `VideoComposerPlugin.load`). A publish can end while no page is listening - in the
            // background, or after the process has gone, since the upload session outlives it - so
            // this replay at the next load is real rather than theoretical, and `acked` is the only
            // thing that stops it repeating at every launch after.
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
            } catch PublishError.fileMissing(let uploadId) {
                call.reject("missing file for \(uploadId)", Reject.fileMissing)
            } catch {
                call.reject("\(error)", Reject.invalidRequest)
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard let batchId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            guard let state = session.state(for: batchId) else {
                // The one legal NSNull in the whole module: the contract's return type is
                // `{ state: PublishState | null }`, so an unknown batch has to answer with a null
                // rather than an absent key.
                call.resolve(["state": NSNull()])
                return
            }
            call.resolve(["state": state])
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let batchId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            // An unknown id is not an error: cancel is usually the first half of a discard, and the
            // caller has no way of knowing whether a record was ever written.
            session.cancel(batchId: batchId)
            call.resolve()
        }
    }

    @objc func retry(_ call: CAPPluginCall) {
        guard let batchId = required(call) else { return }
        let headers = PublishModels.headers(call.getObject("headers"))
        let session = PublisherSession.shared
        session.queue.addOperation {
            do {
                try session.retry(batchId: batchId, headers: headers)
                call.resolve()
            } catch PublishError.notFound(let id) {
                call.reject("nothing to retry for \(id)", Reject.notFound)
            } catch {
                call.reject("\(error)", Reject.invalidRequest)
            }
        }
    }

    @objc func clear(_ call: CAPPluginCall) {
        guard let batchId = required(call) else { return }
        let session = PublisherSession.shared
        session.queue.addOperation {
            session.clear(batchId: batchId)
            call.resolve()
        }
    }

    /* ======================================================================================== */

    /// Rejects and answers nil when the id is missing, `.` or `..`, so every caller is one `guard`
    /// long. The ids and the words are `JobFolders.batchIdRefusal`'s, which `PublishModels.parse`
    /// gives the reason for: `.` and `..` are filed under other batches' names, and `clear` of one
    /// would delete another publish's bodies. Android's `BackgroundPublisherPlugin.batchIdOf` says
    /// the same. `publish` does not use it: its id check comes out of the parser, which reports the
    /// path (`invalid_request:batchId`) like every other field.
    private func required(_ call: CAPPluginCall) -> String? {
        let batchId = call.getString("batchId") ?? ""
        if let refusal = JobFolders.batchIdRefusal(batchId) {
            call.reject(refusal, Reject.invalidRequest)
            return nil
        }
        return batchId
    }
}
