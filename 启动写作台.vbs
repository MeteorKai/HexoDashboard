Option Explicit
' Run the BAT hidden, and exit with it when the page stops the server.
Dim shell, fso, app, bat, blog, logFile, command, result
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
app = fso.GetParentFolderName(WScript.ScriptFullName)
bat = fso.BuildPath(app, fso.GetBaseName(WScript.ScriptFullName) & ".bat")
shell.CurrentDirectory = app
shell.Environment("Process")("HEXO_TOOL_BACKGROUND") = "1"
blog = ""
If WScript.Arguments.Count > 0 Then blog = WScript.Arguments(0)
If Not fso.FolderExists(fso.BuildPath(app, "data")) Then fso.CreateFolder(fso.BuildPath(app, "data"))
' Separate logs prevent a second launch from failing on the first launch's open file.
logFile = fso.BuildPath(app, "data\launcher-" & fso.GetBaseName(fso.GetTempName()) & ".log")
command = Quote(shell.ExpandEnvironmentStrings("%ComSpec%")) & " /d /s /c " & _
          Quote("call " & Quote(bat) & " " & Quote(blog) & " > " & Quote(logFile) & " 2>&1")
On Error Resume Next
result = shell.Run(command, 0, True)
If Err.Number <> 0 Then
  WScript.Echo "Unable to start Hexo Writing Desk: " & Err.Description
  WScript.Quit 1
End If
On Error GoTo 0
If result <> 0 Then WScript.Echo "Hexo Writing Desk stopped with an error. See: " & logFile
WScript.Quit result

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
