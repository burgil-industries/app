' Silently launches APP.cmd from the same data directory
Dim scriptDir, sh
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
Set sh = CreateObject("WScript.Shell")
sh.Run Chr(34) & scriptDir & "..\__APP_NAME__.cmd" & Chr(34), 0, False