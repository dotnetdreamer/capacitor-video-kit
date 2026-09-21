# Active only if a host turns on minification. Capacitor finds @PluginMethod members by reflection,
# so both plugin classes must survive:
# -keep class net.dotnetdreamer.videokit.videocomposer.** { *; }
# -keep class net.dotnetdreamer.videokit.postpublisher.** { *; }
# Media3, OkHttp and WorkManager ship their own consumer rules.
