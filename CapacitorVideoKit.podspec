require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # The name is not a choice. The Capacitor CLI writes `pod 'CapacitorVideoKit', :path => ...` into
  # the host's Podfile from the npm package name - dropping the `@`, treating every `/` and `-` as a
  # word break and uppercasing what follows one (`fixName` in @capacitor/cli) - and CocoaPods then
  # looks for a podspec of exactly that name at the package root. `capacitor-video-kit` gives
  # `CapacitorVideoKit`, which is also the SwiftPM package and product name in Package.swift.
  s.name = 'CapacitorVideoKit'
  # The Swift module keeps the SwiftPM target's name, so a host that has to import it - an
  # AppDelegate forwarding background URLSession events to `PublisherSession` - writes
  # `import CapacitorVideoKitCore` whichever package manager installed it.
  s.module_name = 'CapacitorVideoKitCore'
  s.version = package['version']
  s.summary = 'Native video composition and native background publishing for Capacitor'
  s.license = package['license']
  s.homepage = 'https://github.com/dotnetdreamer/capacitor-video-kit'
  s.author = package['author']
  s.source = { :git => 'https://github.com/dotnetdreamer/capacitor-video-kit.git', :tag => s.version.to_s }
  # One target for both plugin classes, the same shape as Package.swift: Capacitor registers each
  # @objc class separately, so nothing is gained by splitting them.
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  # This has to stay equal to `platforms:` in Package.swift. A host that installs through CocoaPods
  # and one that installs through SwiftPM compile the same Swift, and the floor is held by
  # AVAssetImageGenerator.image(at:) and images(for:) in Thumbnailer.swift.
  s.ios.deployment_target = '16.0'
  # CapacitorCordova, whose module is `Cordova`, arrives as a dependency of Capacitor itself, which
  # is why Package.swift names two products here and this names one.
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
