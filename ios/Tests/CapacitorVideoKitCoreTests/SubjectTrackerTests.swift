import XCTest
@testable import CapacitorVideoKitCore

/// The tracker is a port of the reference every engine follows, so its rules are held here by the
/// cases of `subject-tracker.unit.test.ts`, one for one: what a speck is, what touching means, who is
/// matched to whom, who is forgotten, who was noise, and the order the survivors are numbered in.
final class SubjectTrackerTests: XCTestCase {

    private let W = 20
    private let H = 10

    /// A W x H grid with each rectangle (x0, y0, x1, y1, value), inclusive, filled with its value.
    private func grid(_ boxes: (Int, Int, Int, Int, UInt8)...) -> [UInt8] {
        grid(boxes)
    }

    private func grid(_ boxes: [(Int, Int, Int, Int, UInt8)]) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: W * H)
        for (x0, y0, x1, y1, value) in boxes {
            for y in y0...y1 { for x in x0...x1 { out[y * W + x] = value } }
        }
        return out
    }

    private func finish(_ tracker: SubjectTracker) -> SubjectTrackContent {
        tracker.finish(engine: "mediapipe", kind: "video", durationMs: 1000, fps: 10, subjectKind: "person")
    }

    // MARK: - subjectGrid

    func testPutsSubjectGridCellsOnTheLongerSideAndTheOtherInProportion() {
        XCTAssertTrue(SubjectTracking.subjectGrid(width: 1080, height: 1920) == (180, 320))
        XCTAssertTrue(SubjectTracking.subjectGrid(width: 1920, height: 1080) == (320, 180))
        XCTAssertTrue(SubjectTracking.subjectGrid(width: 1000, height: 1000) == (320, 320))
        XCTAssertTrue(SubjectTracking.subjectGrid(width: 10_000, height: 1) == (320, 1))
        XCTAssertTrue(SubjectTracking.subjectGrid(width: 0, height: 5) == (320, 320))
    }

    // MARK: - toGrid

    func testTakesThePixelUnderEachCellCentreStretchedOverTheWholeFrame() {
        // A 4x4 mask, left half instance 1, read onto a 2x1 grid.
        let mask: [Double] = [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0]
        XCTAssertEqual(SubjectTracking.toGrid(mask, maskWidth: 4, maskHeight: 4, gridWidth: 2, gridHeight: 1), [1, 0])
    }

    func testMakesAConfidenceForegroundAtTheThresholdAndAbove() {
        XCTAssertEqual(SubjectTracking.toGrid([0.49, 0.5, 0.9, 0.1], maskWidth: 4, maskHeight: 1, gridWidth: 4, gridHeight: 1,
                                              threshold: 0.5), [0, 1, 1, 0])
    }

    // MARK: - componentsOf

    func testNumbersTheGroupsThatTouchInScanOrderCornersCountingAsTouching() {
        var cells = grid((0, 0, 4, 9, 1), (5, 0, 9, 9, 1), (12, 0, 19, 9, 1))
        XCTAssertEqual(SubjectTracking.componentsOf(&cells, width: W, height: H), 2)
        XCTAssertEqual(cells[0], 1)
        XCTAssertEqual(cells[9], 1)
        XCTAssertEqual(cells[12], 2)
        // Diagonal neighbours are one group.
        var diagonal = grid((0, 0, 2, 2, 1), (3, 3, 5, 5, 1))
        XCTAssertEqual(SubjectTracking.componentsOf(&diagonal, width: W, height: H), 1)
    }

    func testMakesASpeckBackground() {
        XCTAssertEqual(SubjectTracking.minInstanceCells(W * H), 4)
        var cells = grid((0, 0, 0, 2, 1), (10, 0, 19, 9, 1))
        XCTAssertEqual(SubjectTracking.componentsOf(&cells, width: W, height: H), 1)
        XCTAssertEqual(cells[0], 0)
        XCTAssertEqual(cells[10], 1)
    }

    // MARK: - SubjectTracker

    func testFollowsASubjectThatMovesByOverlapAsOneId() {
        let tracker = SubjectTracker(width: W, height: H)
        for f in 0..<5 { tracker.add(timeMs: Double(f * 100), instances: grid((f, 0, f + 6, 9, 1)), count: 1) }
        let content = finish(tracker)
        XCTAssertEqual(content.meta.subjects.map(\.id), [1])
        XCTAssertTrue(content.frames.allSatisfy { $0.contains(1) })
        let subject = content.meta.subjects[0]
        XCTAssertEqual(subject.startMs, 0)
        XCTAssertEqual(subject.endMs, 400)
        XCTAssertEqual(subject.kind, "person")
    }

    func testKeepsTwoSubjectsApartEvenWhenTheSegmenterNumbersThemDifferentlyInEachFrame() {
        let tracker = SubjectTracker(width: W, height: H)
        tracker.add(timeMs: 0, instances: grid((0, 0, 5, 9, 1), (12, 0, 19, 9, 2)), count: 2)
        tracker.add(timeMs: 100, instances: grid((0, 0, 5, 9, 2), (12, 0, 19, 9, 1)), count: 2)
        tracker.add(timeMs: 200, instances: grid((0, 0, 5, 9, 1), (12, 0, 19, 9, 2)), count: 2)
        let content = finish(tracker)
        // The larger subject (the right one, 8 columns) is the main one, id 1, in every frame.
        for frame in content.frames {
            XCTAssertEqual(frame[12], 1)
            XCTAssertEqual(frame[0], 2)
        }
    }

    func testStartsSomebodyNewForAnInstanceThatOverlapsNobody() {
        let tracker = SubjectTracker(width: W, height: H)
        tracker.add(timeMs: 0, instances: grid((0, 0, 5, 9, 1)), count: 1)
        tracker.add(timeMs: 100, instances: grid((0, 0, 5, 9, 1), (12, 0, 19, 9, 2)), count: 2)
        tracker.add(timeMs: 200, instances: grid((0, 0, 5, 9, 1), (12, 0, 19, 9, 2)), count: 2)
        tracker.add(timeMs: 300, instances: grid((0, 0, 5, 9, 1), (12, 0, 19, 9, 2)), count: 2)
        let subjects = finish(tracker).meta.subjects
        XCTAssertEqual(subjects.count, 2)
        XCTAssertNotNil(subjects.first { $0.startMs == 100 })
    }

    func testForgetsSomebodyGoneLongerThanASecondAndTakesTheirReturnForSomebodyNew() {
        let tracker = SubjectTracker(width: W, height: H)
        for f in 0..<3 { tracker.add(timeMs: Double(f * 100), instances: grid((0, 0, 9, 9, 1)), count: 1) }
        for f in 0..<3 { tracker.add(timeMs: Double(1400 + f * 100), instances: grid((0, 0, 9, 9, 1)), count: 1) }
        let subjects = finish(tracker).meta.subjects
        XCTAssertEqual(subjects.count, 2)
        XCTAssertEqual(subjects.map { [$0.startMs, $0.endMs] }, [[0, 200], [1400, 1600]])
    }

    func testDropsASubjectSeenInFewerThanThreeFramesOrTooSmallToBeOne() {
        let tracker = SubjectTracker(width: W, height: H)
        tracker.add(timeMs: 0, instances: grid((0, 0, 9, 9, 1), (15, 0, 19, 9, 2)), count: 2)
        tracker.add(timeMs: 100, instances: grid((0, 0, 9, 9, 1)), count: 1)
        tracker.add(timeMs: 200, instances: grid((0, 0, 9, 9, 1)), count: 1)
        let content = finish(tracker)
        XCTAssertEqual(content.meta.subjects.map(\.id), [1])
        // The blip's cells are background in the frame it was in.
        XCTAssertEqual(content.frames[0][15], 0)
    }

    func testKeepsAPictureSubjectSeenInItsOneFrame() {
        let tracker = SubjectTracker(width: W, height: H)
        tracker.add(timeMs: 0, instances: grid((2, 2, 8, 8, 1)), count: 1)
        let content = tracker.finish(engine: "vision", kind: "image", durationMs: 0, fps: 0, subjectKind: "subject")
        XCTAssertEqual(content.meta.subjects, [SubjectInfo(id: 1, kind: "subject", startMs: 0, endMs: 0, peakMs: 0,
                                                           box: SubjectBox(x: 0.1, y: 0.2, w: 0.35, h: 0.7), area: 0.245)])
    }

    func testKeepsAtMostMaxSubjectsTheLargest() {
        let tracker = SubjectTracker(width: W, height: H)
        // Ten subjects in two rows of five, each 2x4 with a gap, the later ones a column wider.
        var boxes: [(Int, Int, Int, Int, UInt8)] = []
        for n in 0..<10 {
            let row = n < 5 ? 0 : 5
            let x = (n % 5) * 4
            boxes.append((x, row, x + (n >= 8 ? 2 : 1), row + 3, UInt8(n + 1)))
        }
        for f in 0..<3 { tracker.add(timeMs: Double(f * 100), instances: grid(boxes), count: 10) }
        let subjects = finish(tracker).meta.subjects
        XCTAssertEqual(subjects.count, SubjectTracking.maxSubjects)
        // The two wider ones are first.
        XCTAssertEqual(subjects.prefix(2).map(\.area), [0.06, 0.06])
    }

    // MARK: - Beyond the reference's cases

    func testWritesWhatItFinishesAsATrackThatReadsBack() throws {
        let tracker = SubjectTracker(width: W, height: H)
        for f in 0..<4 { tracker.add(timeMs: Double(f * 67), instances: grid((f, 0, f + 6, 9, 1)), count: 1) }
        let content = finish(tracker)
        let track = try SubjectTrack.parse(try SubjectTrack.encode(content))
        XCTAssertEqual(track.times, [0, 67, 134, 201])
        XCTAssertEqual(try track.frame(3), content.frames[3])
        XCTAssertEqual(track.meta, content.meta)
    }

    func testReadsAnInstanceMaskOrAConfidenceMaskOntoTheGrid() {
        // An instance mask, stretched over the frame: instance 2 on the right half.
        let instances = SubjectMask(width: 4, height: 2, values: [0, 0, 2, 2, 0, 0, 2, 2], instances: 2)
        let (cells, count) = instances.cells(width: 20, height: 10)
        XCTAssertEqual(count, 2)
        XCTAssertEqual(cells[0], 0)
        XCTAssertEqual(cells[19], 2)
        // A confidence mask, thresholded at one half and split into the groups that do not touch.
        var values = [UInt8](repeating: 0, count: 20 * 10)
        for y in 0..<10 { for x in 0..<5 { values[y * 20 + x] = 200 }; for x in 12..<20 { values[y * 20 + x] = 128 } }
        // Just under one half, beside the left group: not foreground, so not part of it.
        values[5] = 127
        let people = SubjectMask(width: 20, height: 10, values: values, instances: nil)
        let (grid, groups) = people.cells(width: 20, height: 10)
        XCTAssertEqual(groups, 2)
        XCTAssertEqual(grid[0], 1)
        XCTAssertEqual(grid[12], 2, "128 of 255 is one half and over")
        XCTAssertEqual(grid[5], 0, "127 of 255 is under one half")
    }
}
