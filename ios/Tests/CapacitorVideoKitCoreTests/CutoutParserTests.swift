import XCTest
@testable import CapacitorVideoKitCore

/// `ComposeClip.cutout` through the parser, by `normaliseComposeCutout`'s rules in its order - which is
/// also Android's `parseCutout` - what is refused and with which path, what is clamped, what is ignored,
/// and that an outline of no width is dropped: on the base track, a layer's clip and a transition's
/// outgoing side alike.
final class CutoutParserTests: RenderTestCase {

    /// A cutout as `compileCutout` sends one: a matte, a soft edge, a white outline.
    private func cutout(_ extra: [String: Any] = [:]) -> [String: Any] {
        var c: [String: Any] = ["uri": "file:///mattes/a.vkmt", "soft": 0.25, "outline": ["color": [1, 1, 1], "width": 0.012]]
        for (k, v) in extra { c[k] = v }
        return c
    }

    private func spec(_ cutout: Any?) -> [String: Any] {
        var clip = TestSpecs.clip("a", file("a.mp4"), outMs: 4000)
        if let cutout { clip["cutout"] = cutout }
        return TestSpecs.spec([clip])
    }

    private func cutoutOf(_ cutout: Any?) throws -> ComposeCutout? {
        try TestCalls.parse(spec(cutout)).clips[0].cutout
    }

    private func assertRefused(_ cutout: Any?, _ path: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try cutoutOf(cutout), file: file, line: line) { error in
            let refused = error as? SpecError
            XCTAssertEqual(refused?.path, path, file: file, line: line)
            XCTAssertEqual(refused?.message, "invalid_spec:\(path)", file: file, line: line)
        }
    }

    func testNoCutoutAndANullOneAreTheFootageAsItIs() throws {
        XCTAssertNil(try cutoutOf(nil))
        XCTAssertNil(try cutoutOf(NSNull()))
    }

    func testACutoutIsReadWithEveryValueClampedAndUnknownKeysIgnored() throws {
        let read = try XCTUnwrap(try cutoutOf(cutout([
            "soft": 2, "shift": -3, "fill": [1.5, -1, 0.25], "shadow": true, "target": "people",
            "outline": ["color": [0.5, 2, -0.5], "width": 0.5, "dash": 3],
        ])))
        XCTAssertEqual(read.uri, "file:///mattes/a.vkmt")
        XCTAssertEqual(read.soft, 1)
        XCTAssertEqual(read.shift, -1)
        let fill = try XCTUnwrap(read.fill)
        XCTAssertEqual([fill.r, fill.g, fill.b], [1, 0, 0.25])
        let outline = try XCTUnwrap(read.outline)
        XCTAssertEqual([outline.color.r, outline.color.g, outline.color.b], [0.5, 1, 0])
        XCTAssertEqual(outline.width, ComposeCutout.maxOutline)
        XCTAssertEqual(ComposeCutout.maxOutline, 0.04)
    }

    func testAbsentValuesAreNothing() throws {
        let read = try XCTUnwrap(try cutoutOf(["uri": "file:///mattes/a.vkmt", "soft": NSNull(), "shift": NSNull(),
                                               "fill": NSNull(), "outline": NSNull()]))
        XCTAssertEqual(read.soft, 0)
        XCTAssertEqual(read.shift, 0)
        XCTAssertNil(read.fill)
        XCTAssertNil(read.outline)
        // A bare matte is a cutout: transparent where the background was, its edge as the refinement leaves it.
        let bare = try XCTUnwrap(try cutoutOf(["uri": "file:///mattes/a.vkmt"]))
        XCTAssertEqual(bare.soft, 0)
        XCTAssertNil(bare.outline)
    }

    func testAnOutlineOfNoWidthIsDropped() throws {
        XCTAssertNil(try cutoutOf(cutout(["outline": ["color": [1, 1, 1], "width": 0]]))?.outline)
        XCTAssertNil(try cutoutOf(cutout(["outline": ["color": [1, 1, 1], "width": -0.5]]))?.outline, "clamped to 0")
        XCTAssertEqual(try cutoutOf(cutout())?.outline?.width, 0.012)
    }

    func testACutoutNoEngineCouldDrawIsRefusedNamingWhatBrokeInTheReferencesOrder() {
        assertRefused("cutout", "clips[0].cutout")
        assertRefused([1, 2], "clips[0].cutout")
        assertRefused(7, "clips[0].cutout")
        assertRefused(cutout(["uri": ""]), "clips[0].cutout.uri")
        assertRefused(cutout(["uri": 7]), "clips[0].cutout.uri")
        var noUri = cutout()
        noUri["uri"] = nil
        assertRefused(noUri, "clips[0].cutout.uri")
        // `uri` before `soft` before `shift` before `fill` before `outline`.
        assertRefused(cutout(["uri": "", "soft": "x"]), "clips[0].cutout.uri")
        assertRefused(cutout(["soft": "x"]), "clips[0].cutout.soft")
        assertRefused(cutout(["soft": [0.5]]), "clips[0].cutout.soft")
        assertRefused(cutout(["shift": "in"]), "clips[0].cutout.shift")
        assertRefused(cutout(["soft": "x", "shift": "in"]), "clips[0].cutout.soft")
        assertRefused(cutout(["shift": "in", "fill": "red"]), "clips[0].cutout.shift")
        assertRefused(cutout(["fill": "red"]), "clips[0].cutout.fill")
        assertRefused(cutout(["fill": [1, 1]]), "clips[0].cutout.fill")
        assertRefused(cutout(["fill": [1, 1, 1, 1]]), "clips[0].cutout.fill")
        assertRefused(cutout(["fill": [1, 1, "x"]]), "clips[0].cutout.fill")
        assertRefused(cutout(["fill": [1, NSNull(), 1]]), "clips[0].cutout.fill")
        assertRefused(cutout(["fill": "red", "outline": "thick"]), "clips[0].cutout.fill")
        assertRefused(cutout(["outline": "thick"]), "clips[0].cutout.outline")
        assertRefused(cutout(["outline": [1, 2]]), "clips[0].cutout.outline")
        assertRefused(cutout(["outline": ["width": 0.01]]), "clips[0].cutout.outline.color")
        assertRefused(cutout(["outline": ["color": [1, 1], "width": 0.01]]), "clips[0].cutout.outline.color")
        assertRefused(cutout(["outline": ["color": NSNull(), "width": 0.01]]), "clips[0].cutout.outline.color")
        assertRefused(cutout(["outline": ["color": [1, 1, 1]]]), "clips[0].cutout.outline.width")
        assertRefused(cutout(["outline": ["color": [1, 1, 1], "width": "wide"]]), "clips[0].cutout.outline.width")
        assertRefused(cutout(["outline": ["color": [1, 1, 1], "width": NSNull()]]), "clips[0].cutout.outline.width")
        // The colour before the width.
        assertRefused(cutout(["outline": ["color": "white", "width": "wide"]]), "clips[0].cutout.outline.color")
    }

    func testACutoutIsReadLastOnTheClipAfterItsFocus() {
        var clip = TestSpecs.clip("a", file("a.mp4"), inMs: 500, outMs: 400)
        clip["cutout"] = "cutout"
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([clip]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[0].outMs")
        }
        var both = TestSpecs.clip("a", file("a.mp4"), outMs: 1000)
        both["focus"] = ["uri": ""]
        both["cutout"] = ["uri": ""]
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([both]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[0].focus.uri")
        }
        // And before the transition a base clip carries after its own fields.
        var second = TestSpecs.clip("b", file("b.mp4"), outMs: 1000)
        second["cutout"] = ["uri": "file:///mattes/b.vkmt", "fill": [1]]
        second["transitionIn"] = "dissolve"
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 1000), second]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[1].cutout.fill")
        }
    }

    func testACutoutReachesALayersClipsAndATransitionsOutgoingSideWithTheirPaths() throws {
        var layerClip = TestSpecs.clip("p", file("p.mp4"), outMs: 1000)
        layerClip["cutout"] = cutout(["fill": [0, 1, 0]])
        var from = TestSpecs.clip("a", file("a.mp4"), inMs: 600, outMs: 1000)
        from["cutout"] = cutout(["shift": 0.5])
        let parsed = try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("a", file("a.mp4"), outMs: 600),
            TestSpecs.clip("b", file("b.mp4"), outMs: 1000, ["transitionIn": ["kind": "dissolve", "from": from,
                                                                              "curves": ["alpha": [0.0, 1.0]]]]),
        ], ["tracks": [["id": "pip", "z": 1, "clips": [layerClip]]]]))
        XCTAssertEqual(parsed.tracks?.first?.clips.first?.cutout?.fill?.g, 1)
        XCTAssertEqual(parsed.clips[1].transitionIn?.from.cutout?.shift, 0.5)
        XCTAssertNil(parsed.clips[0].cutout)
        // Every file the render opens, the matte tracks among them.
        XCTAssertEqual(parsed.inputURIs.filter { $0 == "file:///mattes/a.vkmt" }.count, 2)

        layerClip["cutout"] = cutout(["soft": "x"])
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 600)],
                                                                ["tracks": [["id": "pip", "clips": [layerClip]]]]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "tracks[0].clips[0].cutout.soft")
        }
        from["cutout"] = cutout(["outline": ["color": [1, 1, 1], "width": "wide"]])
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("a", file("a.mp4"), outMs: 600),
            TestSpecs.clip("b", file("b.mp4"), outMs: 1000, ["transitionIn": ["kind": "dissolve", "from": from,
                                                                              "curves": ["alpha": [0.0, 1.0]]]]),
        ]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "clips[1].transitionIn.from.cutout.outline.width")
        }
    }

    func testAPictureKeepsItsCutoutAndAFocusAndACutoutLiveTogether() throws {
        var picture = TestSpecs.clip("p", file("p.jpg"), outMs: 1000, ["image": true])
        picture["cutout"] = cutout()
        picture["focus"] = ["uri": "file:///subjects/p.vkst", "atMs": [0], "subjects": [["id": 1, "focus": [1]]], "blur": 0.01]
        let parsed = try TestCalls.parse(TestSpecs.spec([picture]))
        XCTAssertTrue(parsed.clips[0].image)
        XCTAssertEqual(parsed.clips[0].cutout?.soft, 0.25)
        XCTAssertEqual(parsed.clips[0].focus?.blur, 0.01)
    }
}
