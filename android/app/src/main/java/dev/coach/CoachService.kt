package dev.coach

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class CoachService : LifecycleService() {
    lateinit var session: CoachSession; private set
    inner class LocalBinder : Binder() { val service get() = this@CoachService }
    private val binder = LocalBinder()
    fun startSession(settings: Settings) { lifecycleScope.launch { session.start(settings) } }
    override fun onCreate() {
        super.onCreate()
        session = CoachSession(this, this, lifecycleScope)
        getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("coach", "Active coaching session", NotificationManager.IMPORTANCE_LOW))
        lifecycleScope.launch { session.state.collect { if (it.status in CoachSession.terminalStates) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() } } }
    }
    override fun onBind(intent: Intent): IBinder { super.onBind(intent); return binder }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == "end") {
            lifecycleScope.launch { session.end(); stopForeground(STOP_FOREGROUND_REMOVE); stopSelf() }
            return START_NOT_STICKY
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, CoachService::class.java).setAction("end"), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "coach").setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Wearable Coach session").setContentText("Microphone and camera may be active. Tap to open controls.")
            .setContentIntent(open).setOngoing(true).addAction(0, "End session", stop).build()
        startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA)
        return START_NOT_STICKY
    }
    override fun onDestroy() { session.release(); super.onDestroy() }
}
