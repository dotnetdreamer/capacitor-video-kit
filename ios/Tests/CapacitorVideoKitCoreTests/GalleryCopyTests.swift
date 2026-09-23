import Photos
import XCTest
@testable import CapacitorVideoKitCore

/// The parts of the photo library code that need no photo library: where a picked item's copy and
/// tile are kept and what they are called, and how a save's options, album and failures are read.
final class GalleryCopyTests: XCTestCase {

    // MARK: - Where a copy lives

    func testKeepsOneFolderPerAssetAndOnePerEdit() {
        let folder = URL(fileURLWithPath: "/app/Library/Application Support/videokit-gallery")
        let id = "9F983DBA-EC35-42B8-8773-B597CF782EDD/L0/001"
        let modified = Date(timeIntervalSince1970: 1_700_000_000.123)

        let copy = copyURL(in: folder, id, edited: true, modified: modified)
        XCTAssertEqual(copy.path,
                       folder.path + "/9F983DBA_EC35_42B8_8773_B597CF782EDD_L0_001/1700000000123/IMG_0042.MOV")
        XCTAssertEqual(copy.lastPathComponent, "IMG_0042.MOV")

        // The same edit is the same file, so a second pick reuses it ...
        XCTAssertEqual(copyURL(in: folder, id, edited: true, modified: modified), copy)
        // ... and another edit in Photos is a new one, beside the old one a draft may still use.
        let reEdited = copyURL(in: folder, id, edited: true, modified: modified.addingTimeInterval(60))
        XCTAssertNotEqual(reEdited, copy)
        XCTAssertEqual(reEdited.deletingLastPathComponent().deletingLastPathComponent(),
                       copy.deletingLastPathComponent().deletingLastPathComponent())
    }

    func testAnUneditedItemHasOneCopyWhateverHappensToItsDate() {
        // A favourite, a caption or a new date moves the modification date and not one byte of
        // the original, so none of them is a reason to copy it again.
        let folder = URL(fileURLWithPath: "/g")
        let first = copyURL(in: folder, "a/b", edited: false, modified: Date(timeIntervalSince1970: 1_700_000_000))
        XCTAssertEqual(first.path, "/g/a_b/original/IMG_0042.MOV")
        XCTAssertEqual(copyURL(in: folder, "a/b", edited: false, modified: Date(timeIntervalSince1970: 1_800_000_000)),
                       first)
        XCTAssertEqual(copyURL(in: folder, "a/b", edited: false, modified: nil), first)
    }

    func testAnEditedItemWithNoModificationDateStaysApartFromItsOriginal() {
        let folder = URL(fileURLWithPath: "/g")
        XCTAssertEqual(copyURL(in: folder, "a/b", edited: true, modified: nil).path, "/g/a_b/edited/IMG_0042.MOV")
    }

    private func copyURL(in folder: URL, _ id: String, edited: Bool, modified: Date?) -> URL {
        GalleryLibrary.copyURL(in: folder, id: id, edited: edited, modified: modified, name: "IMG_0042.MOV")
    }

    func testFindsTheFlatCopyEarlierVersionsMade() {
        // Where the previous `resolve` wrote `"\(safeName(id))-\(originalFilename)"`.
        let folder = URL(fileURLWithPath: "/g")
        XCTAssertEqual(GalleryLibrary.legacyCopyURL(in: folder, id: "9F98/L0/001", name: "IMG_0042.MOV").path,
                       "/g/9F98_L0_001-IMG_0042.MOV")
    }

    func testTheCopiesLiveInApplicationSupport() {
        XCTAssertEqual(GalleryLibrary.copiesFolder.lastPathComponent, "videokit-gallery")
        XCTAssertEqual(GalleryLibrary.copiesFolder.deletingLastPathComponent(),
                       FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0])
    }

    // MARK: - Where a tile lives

    func testNamesATileApartFromTheFilledOnesEarlierVersionsKept() {
        let tile = GalleryLibrary.thumbnailURL(id: "9F98/L0/001", maxSize: 240)
        XCTAssertEqual(tile.lastPathComponent, "9F98_L0_001-fit240.jpg")
        XCTAssertNotEqual(tile.lastPathComponent, "9F98_L0_001-240.jpg")
        XCTAssertEqual(tile.deletingLastPathComponent().lastPathComponent, "videokit-gallery-thumbnails")
        XCTAssertEqual(tile.deletingLastPathComponent().deletingLastPathComponent(),
                       FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0])
    }

    // MARK: - What a copy is called

    func testNamesAnEditedItemAfterItsOriginal() {
        XCTAssertEqual(name(original: "IMG_0042.MOV", copied: "FullSizeRender.mov"), "IMG_0042.MOV")
        XCTAssertEqual(name(original: "IMG_0042.HEIC", copied: "FullSizeRender.heic"), "IMG_0042.HEIC")
        XCTAssertEqual(name(original: "IMG_0042.MOV", copied: "IMG_0042.MOV"), "IMG_0042.MOV")
    }

    func testTakesTheExtensionOfTheBytesThatAreCopied() {
        // An edited RAW is copied as its rendered JPEG, and must not be called `.DNG`.
        XCTAssertEqual(name(original: "IMG_0042.DNG", copied: "FullSizeRender.jpg"), "IMG_0042.jpg")
        XCTAssertEqual(name(original: "IMG_0042", copied: "FullSizeRender.heic"), "IMG_0042.heic")
        XCTAssertEqual(name(original: "IMG_0042.MOV", copied: "FullSizeRender"), "IMG_0042.MOV")
    }

    func testFallsBackToTheCopiedNameAndKeepsToOnePathComponent() {
        XCTAssertEqual(name(original: "", copied: "FullSizeRender.mov"), "FullSizeRender.mov")
        XCTAssertEqual(name(original: "Trip/Day 1.mov", copied: "x.mov"), "Trip_Day 1.mov")
        XCTAssertEqual(name(original: "..", copied: ""), "")
        XCTAssertEqual(name(original: "", copied: ""), "")
    }

    private func name(original: String, copied: String) -> String {
        GalleryLibrary.displayName(original: original, copied: copied)
    }

    // MARK: - A save's options

    func testAcceptsTheTwoDirectoriesAndLeavesThemOut() throws {
        for directory in [nil, "", "movies", "MOVIES", "dcim", "DCIM"] {
            XCTAssertNil(try Gallery.album(nil, directory: directory), String(describing: directory))
        }
    }

    func testRefusesAnyOtherDirectoryInAndroidsWords() {
        XCTAssertThrowsError(try Gallery.album("LightSnip", directory: "pictures")) { error in
            let rejection = Gallery.rejection(for: error)
            XCTAssertEqual(rejection.code, "invalid_spec")
            XCTAssertEqual(rejection.message, "directory is movies or dcim, not: pictures")
        }
    }

    func testTrimsTheAlbumAndReadsABlankOneAsNone() throws {
        XCTAssertEqual(try Gallery.album("  LightSnip \n", directory: nil), "LightSnip")
        XCTAssertNil(try Gallery.album("   ", directory: "movies"))
    }

    func testRefusesANestedAlbumInAndroidsWords() {
        for album in ["Trips/2026", "Trips\\2026", " a/b "] {
            XCTAssertThrowsError(try Gallery.album(album, directory: nil)) { error in
                let rejection = Gallery.rejection(for: error)
                XCTAssertEqual(rejection.code, "invalid_spec")
                XCTAssertTrue(rejection.message.hasPrefix("album is one folder name, not a path: "),
                              rejection.message)
            }
        }
    }

    func testChecksTheDirectoryBeforeTheAlbumAsAndroidDoes() {
        XCTAssertThrowsError(try Gallery.album("a/b", directory: "downloads")) { error in
            XCTAssertEqual(Gallery.rejection(for: error).message, "directory is movies or dcim, not: downloads")
        }
    }

    // MARK: - A save's album

    func testAsksForReadingOnceAndFilesOnlyWithFullAccess() {
        XCTAssertEqual(Gallery.albumStep(readWrite: .notDetermined, hostDeclaresReading: true), .ask)
        XCTAssertEqual(Gallery.albumStep(readWrite: .authorized, hostDeclaresReading: true), .file)
        // Limited, denied and restricted all save to Recents without the album, and never ask again.
        for status in [PHAuthorizationStatus.limited, .denied, .restricted] {
            XCTAssertEqual(Gallery.albumStep(readWrite: status, hostDeclaresReading: true), .skip, "\(status.rawValue)")
        }
    }

    func testNeverAsksForReadingWhereTheHostCannotBeAsked() {
        // No `NSPhotoLibraryUsageDescription`: asking would terminate the app, so no status asks.
        for status in [PHAuthorizationStatus.notDetermined, .authorized, .limited, .denied, .restricted] {
            XCTAssertEqual(Gallery.albumStep(readWrite: status, hostDeclaresReading: false), .skip, "\(status.rawValue)")
        }
    }

    // MARK: - A save's failures

    func testRejectsOnlyWithSaveToGalleryFailureCodes() {
        let cases: [(Error, String)] = [
            (Gallery.GalleryError.permissionDenied, "permission_denied"),
            (Gallery.GalleryError.unreadable("there is no file to read at /x"), "unreadable_input"),
            (Gallery.GalleryError.saveFailed("the photo library refused the video"), "unknown"),
            (NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError), "no_space"),
            (NSError(domain: PHPhotosErrorDomain, code: -1, userInfo: [
                NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC)),
            ]), "no_space"),
            (photos(.notEnoughSpace), "no_space"),
            (photos(.accessUserDenied), "permission_denied"),
            (photos(.accessRestricted), "permission_denied"),
            (photos(.invalidResource), "unreadable_input"),
            (photos(.missingResource), "unreadable_input"),
            (NSError(domain: PHPhotosErrorDomain, code: -1), "unknown"),
            (NSError(domain: "SomethingElse", code: 7), "unknown"),
        ]
        for (error, code) in cases {
            XCTAssertEqual(Gallery.rejection(for: error).code, code, "\(error)")
        }
    }

    private func photos(_ code: PHPhotosError.Code) -> NSError {
        NSError(domain: PHPhotosErrorDomain, code: code.rawValue)
    }

    func testCarriesTheLibrarysOwnWordsForAnUnknownFailure() {
        let error = NSError(domain: PHPhotosErrorDomain, code: -1,
                            userInfo: [NSLocalizedDescriptionKey: "The operation could not be completed"])
        XCTAssertTrue(Gallery.rejection(for: error).message.contains("The operation could not be completed"))
    }
}
