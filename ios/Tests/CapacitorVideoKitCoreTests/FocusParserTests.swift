import XCTest
@testable import CapacitorVideoKitCore

/// `ComposeClip.focus` through the parser, by `normaliseComposeFocus`'s rules in its order: what is
/// refused and with which path, what is clamped, what is ignored, and that a focus which changes nothing
/// is dropped - on the base track, a layer's clip and a transition's outgoing side alike.
final class FocusParserTests: RenderTestCase {

    /// A focus as `compileFocus` sends one: subject 1 sharp at one key, the rest softened.
    private func focus(_ extra: [String: Any] = [:]) -> [String: Any] {
        var f: [String: Any] = ["uri": "file:///subjects/a.vkst", "atMs": [0], "subjects": [["id": 1, "focus": [1]]],
                                "blur": 0.015]
        for (k, v) in extra { f[k] = v }
        return f
    }

    private func spec(_ focus: Any?) -> [String: Any] {
        var clip = TestSpecs.clip("a", file("a.mp4"), outMs: 4000)
        if let focus { clip["focus"] = focus }
        return TestSpecs.spec([clip])
    }

    private func focusOf(_ focus: Any?) throws -> ComposeFocus? {
        try TestCalls.parse(spec(focus)).clips[0].focus
    }

    private func assertRefused(_ focus: Any?, _ path: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try focusOf(focus), file: file, line: line) { error in
            let refused = error as? SpecError
            XCTAssertEqual(refused?.path, path, file: file, line: line)
            XCTAssertEqual(refused?.message, "invalid_spec:\(path)", file: file, line: line)
        }
    }

    func testNoFocusAndANullOneAreTheFootageAsItIs() throws {
        XCTAssertNil(try focusOf(nil))
        XCTAssertNil(try focusOf(NSNull()))
    }

    func testAFocusIsReadWithEveryValueClampedAndUnknownKeysIgnored() throws {
        let read = try XCTUnwrap(try focusOf(focus([
            "atMs": [0, 500, 500, 2000],
            "subjects": [["id": 3, "focus": [1.5, -0.25, 0.5, 1], "later": true], ["id": 255, "focus": [0, 0, 1, 1]]],
            "blur": 0.5, "mono": 2, "dim": -1, "invert": true, "pullMs": 300,
        ])))
        XCTAssertEqual(read.uri, "file:///subjects/a.vkst")
        XCTAssertEqual(read.atMs, [0, 500, 500, 2000])
        XCTAssertEqual(read.subjects.map(\.id), [3, 255])
        XCTAssertEqual(read.subjects[0].focus, [1, 0, 0.5, 1])
        XCTAssertEqual(read.blur, ComposeFocus.maxBlur)
        XCTAssertEqual(read.mono, 1)
        XCTAssertEqual(read.dim, 0)
        XCTAssertTrue(read.invert)
    }

    func testAbsentLooksAreNothingAndInvertIsFalseUnlessItIsTrue() throws {
        let read = try XCTUnwrap(try focusOf(focus(["mono": NSNull(), "invert": "yes"])))
        XCTAssertEqual(read.blur, 0.015)
        XCTAssertEqual(read.mono, 0)
        XCTAssertEqual(read.dim, 0)
        XCTAssertFalse(read.invert)
        // A subject list may be empty: the whole frame is then softened.
        XCTAssertEqual(try focusOf(focus(["subjects": [Any]()]))?.subjects.count, 0)
    }

    func testAFocusThatChangesNothingIsDropped() throws {
        XCTAssertNil(try focusOf(focus(["blur": 0])))
        XCTAssertNil(try focusOf(focus(["blur": 0, "mono": 0, "dim": 0])))
        XCTAssertNil(try focusOf(focus(["blur": -3])), "clamped to 0 and so nothing")
        XCTAssertNotNil(try focusOf(focus(["blur": 0, "dim": 0.2])))
    }

    func testAFocusNoEngineCouldDrawIsRefusedNamingWhatBrokeInTheReferencesOrder() {
        assertRefused("focus", "clips[0].focus")
        assertRefused([1, 2], "clips[0].focus")
        assertRefused(focus(["uri": ""]), "clips[0].focus.uri")
        assertRefused(focus(["uri": 7]), "clips[0].focus.uri")
        var noUri = focus()
        noUri["uri"] = nil
        assertRefused(noUri, "clips[0].focus.uri")
        // `uri` before `atMs`.
        assertRefused(focus(["uri": "", "atMs": "soon"]), "clips[0].focus.uri")
        assertRefused(focus(["atMs": "soon"]), "clips[0].focus.atMs")
        assertRefused(focus(["atMs": NSNull()]), "clips[0].focus.atMs")
        assertRefused(focus(["atMs": [Any](), "subjects": [Any]()]), "clips[0].focus.atMs")
        assertRefused(focus(["atMs": [Double](repeating: 0, count: ComposeFocus.maxKeys + 1), "subjects": [Any]()]),
                      "clips[0].focus.atMs")
        assertRefused(focus(["atMs": [100, 50], "subjects": [["id": 1, "focus": [1, 1]]]]), "clips[0].focus.atMs[1]")
        assertRefused(focus(["atMs": [0, "x"], "subjects": [["id": 1, "focus": [1, 1]]]]), "clips[0].focus.atMs[1]")
        assertRefused(focus(["atMs": [0, NSNull()], "subjects": [["id": 1, "focus": [1, 1]]]]), "clips[0].focus.atMs[1]")
        var noSubjects = focus()
        noSubjects["subjects"] = nil
        assertRefused(noSubjects, "clips[0].focus.subjects")
        assertRefused(focus(["subjects": ["one"]]), "clips[0].focus.subjects[0]")
        for id: Any in [0, 256, 1.5, "1", NSNull()] {
            assertRefused(focus(["subjects": [["id": id, "focus": [1]]]]), "clips[0].focus.subjects[0].id")
        }
        assertRefused(focus(["subjects": [["id": 2, "focus": [1]], ["id": 2, "focus": [0]]]]), "clips[0].focus.subjects[1].id")
        assertRefused(focus(["subjects": [["id": 2]]]), "clips[0].focus.subjects[0].focus")
        assertRefused(focus(["subjects": [["id": 2, "focus": [1, 1]]]]), "clips[0].focus.subjects[0].focus")
        assertRefused(focus(["subjects": [["id": 2, "focus": 1]]]), "clips[0].focus.subjects[0].focus")
        assertRefused(focus(["atMs": [0, 10], "subjects": [["id": 2, "focus": [1, "x"]]]]), "clips[0].focus.subjects[0].focus[1]")
        // Each subject whole before the next.
        assertRefused(focus(["subjects": [["id": 2, "focus": ["x"]], ["id": 0, "focus": [1]]]]), "clips[0].focus.subjects[0].focus[0]")
        assertRefused(focus(["blur": "soft"]), "clips[0].focus.blur")
        assertRefused(focus(["mono": "grey"]), "clips[0].focus.mono")
        assertRefused(focus(["dim": [0.5]]), "clips[0].focus.dim")
        // `blur` before `mono` before `dim`.
        assertRefused(focus(["blur": "soft", "mono": "grey", "dim": "dark"]), "clips[0].focus.blur")
    }

    func testAFocusIsReadLastOnTheClip() {
        var clip = TestSpecs.clip("a", file("a.mp4"), inMs: 500, outMs: 400)
        clip["focus"] = "focus"
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([clip]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[0].outMs")
        }
        // And before the transition a base clip carries after its own fields.
        var second = TestSpecs.clip("b", file("b.mp4"), outMs: 1000)
        second["focus"] = ["uri": ""]
        second["transitionIn"] = "dissolve"
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 1000), second]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[1].focus.uri")
        }
    }

    func testAFocusReachesALayersClipsAndATransitionsOutgoingSideWithTheirPaths() throws {
        var layerClip = TestSpecs.clip("p", file("p.mp4"), outMs: 1000)
        layerClip["focus"] = focus(["mono": 1])
        var from = TestSpecs.clip("a", file("a.mp4"), inMs: 600, outMs: 1000)
        from["focus"] = focus(["dim": 0.5])
        let parsed = try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("a", file("a.mp4"), outMs: 600),
            TestSpecs.clip("b", file("b.mp4"), outMs: 1000, ["transitionIn": ["kind": "dissolve", "from": from,
                                                                              "curves": ["alpha": [0.0, 1.0]]]]),
        ], ["tracks": [["id": "pip", "z": 1, "clips": [layerClip]]]]))
        XCTAssertEqual(parsed.tracks?.first?.clips.first?.focus?.mono, 1)
        XCTAssertEqual(parsed.clips[1].transitionIn?.from.focus?.dim, 0.5)
        XCTAssertNil(parsed.clips[0].focus)
        // Every file the render opens, the tracks among them.
        XCTAssertEqual(parsed.inputURIs.filter { $0 == "file:///subjects/a.vkst" }.count, 2)

        layerClip["focus"] = focus(["atMs": [Any]()])
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 600)],
                                                                ["tracks": [["id": "pip", "clips": [layerClip]]]]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "tracks[0].clips[0].focus.atMs")
        }
        from["focus"] = focus(["subjects": [["id": 9, "focus": [Any]()]]])
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("a", file("a.mp4"), outMs: 600),
            TestSpecs.clip("b", file("b.mp4"), outMs: 1000, ["transitionIn": ["kind": "dissolve", "from": from,
                                                                              "curves": ["alpha": [0.0, 1.0]]]]),
        ]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[1].transitionIn.from.focus.subjects[0].focus")
        }
    }

    func testAPictureKeepsItsFocus() throws {
        var picture = TestSpecs.clip("p", file("p.jpg"), outMs: 1000, ["image": true])
        picture["focus"] = focus(["atMs": [0, 1000], "subjects": [["id": 1, "focus": [1, 0]]]])
        let parsed = try TestCalls.parse(TestSpecs.spec([picture]))
        XCTAssertTrue(parsed.clips[0].image)
        XCTAssertEqual(parsed.clips[0].focus?.atMs, [0, 1000])
    }
}
