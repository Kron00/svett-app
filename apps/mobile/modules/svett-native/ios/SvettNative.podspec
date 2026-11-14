Pod::Spec.new do |s|
  s.name           = 'SvettNative'
  s.version        = '0.0.0'
  s.summary        = 'svett native code: the phone checks and the ChatGPT sign-in'
  s.license        = 'MIT'
  s.author         = 'Kron00'
  s.homepage       = 'https://github.com/Kron00/svett-app'
  s.platforms      = { :ios => '27.0' }
  s.swift_version  = '5.9'
  s.source         = { git: 'https://github.com/Kron00/svett-app.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit', 'AuthenticationServices', 'Network', 'Security'

  s.source_files = '**/*.swift'
  # ChatGPTCore is also a Swift package, so that `swift test` runs its tests on a Mac.
  s.exclude_files = 'ChatGPTCore/Package.swift', 'ChatGPTCore/Tests/**/*', 'ChatGPTCore/.build/**/*'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
