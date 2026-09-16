plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}
// Display firmware v128 needs the legacy camera transport; DAT 0.9 removes that opt-out.
val metaDatVersion = "0.8.0"
android {
    namespace = "dev.coach"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.coach.wearable"
        minSdk = 31
        targetSdk = 36
        versionCode = 2
        versionName = "0.1.1"
        buildConfigField("String", "META_DAT_VERSION", "\"$metaDatVersion\"")
        manifestPlaceholders["mwdat_application_id"] = providers.gradleProperty("mwdat_application_id").getOrElse("0")
        manifestPlaceholders["mwdat_client_token"] = providers.gradleProperty("mwdat_client_token").getOrElse("0")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true; buildConfig = true }
    packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
}
kotlin { compilerOptions { jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17 } }
dependencies {
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation(platform("androidx.compose:compose-bom:2026.05.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-service:2.10.0")
    implementation("androidx.camera:camera-camera2:1.5.3")
    implementation("androidx.camera:camera-lifecycle:1.5.3")
    implementation("androidx.exifinterface:exifinterface:1.4.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.meta.wearable:mwdat-core:$metaDatVersion")
    implementation("com.meta.wearable:mwdat-camera:$metaDatVersion")
    implementation("com.meta.wearable:mwdat-display:$metaDatVersion")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}
