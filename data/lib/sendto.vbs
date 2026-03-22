If WScript.Arguments.Count > 0 Then
    Dim scriptDir, sh
    scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
    Set sh = CreateObject("WScript.Shell")
    sh.Run "wscript.exe """ & scriptDir & "router.vbs"" ""ali://open?path=" & WScript.Arguments(0) & """", 0, False
End If
