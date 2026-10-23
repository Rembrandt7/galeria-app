const { withGradleProperties } = require('expo/config-plugins');

module.exports = function withFastAndroidBuild(config) {
  return withGradleProperties(config, (config) => {
    const setProp = (key, value) => {
      const idx = config.modResults.findIndex(
        (item) => item.type === 'property' && item.key === key
      );
      if (idx >= 0) {
        config.modResults[idx].value = value;
      } else {
        config.modResults.push({ type: 'property', key, value });
      }
    };

    // Compilar únicamente para procesadores ARM de celulares reales (omite emuladores x86 y x86_64)
    setProp('reactNativeArchitectures', 'arm64-v8a,armeabi-v7a');
    // Activar compilación paralela y caché de Gradle con 4 GB de RAM
    setProp('org.gradle.parallel', 'true');
    setProp('org.gradle.caching', 'true');
    setProp('org.gradle.configureondemand', 'true');
    setProp('org.gradle.jvmargs', '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8');

    return config;
  });
};
