#!/bin/sh
set -eu
PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ -z "${JAVA_HOME:-}" ]; then
    for candidate in "$PROJECT_ROOT"/.tools/jdk-*/Contents/Home; do
        if [ -x "$candidate/bin/java" ]; then export JAVA_HOME="$candidate"; break; fi
    done
fi
export ANDROID_HOME="${ANDROID_HOME:-$PROJECT_ROOT/.tools/android-sdk}"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$PROJECT_ROOT/.tools/gradle-cache}"
if [ "$#" -eq 0 ]; then set -- :app:assembleDebug :app:testDebugUnitTest; fi
exec "$PROJECT_ROOT/android/gradlew" -p "$PROJECT_ROOT/android" "$@" --console=plain
