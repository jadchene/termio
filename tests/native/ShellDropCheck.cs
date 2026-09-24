using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Web.Script.Serialization;
using MyTerminal.VirtualFileDrag;

/// <summary>真实 Windows Shell 接收方回归测试。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
internal static class ShellDropCheck
{
    /// <summary>Shell 项目绑定接口。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IBindCtx context, ref Guid handler, ref Guid iid, out IntPtr value);
    }
    /// <summary>原生拖放接收接口。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
    [ComImport, Guid("00000122-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDropTarget
    {
        [PreserveSig] int DragEnter([MarshalAs(UnmanagedType.Interface)] IDataObject data, uint keys, NativePoint point, ref uint effect);
        [PreserveSig] int DragOver(uint keys, NativePoint point, ref uint effect);
        [PreserveSig] int DragLeave();
        [PreserveSig] int Drop([MarshalAs(UnmanagedType.Interface)] IDataObject data, uint keys, NativePoint point, ref uint effect);
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IBindCtx context, ref Guid iid, out IShellItem item);
    [DllImport("ole32.dll")]
    private static extern int GetRunningObjectTable(uint reserved, out IRunningObjectTable table);
    [DllImport("ole32.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateItemMoniker(string delimiter, string item, out IMoniker moniker);

    /** 跨进程调用需要持续处理 STA 消息，不能用阻塞等待代替消息泵。 */
    private static void Pump()
    {
        NativeMessage message;
        while (NativeMethods.PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
            NativeMethods.TranslateMessage(ref message);
            NativeMethods.DispatchMessage(ref message);
        }
        Thread.Sleep(5);
    }

    /** 在另一个进程中接收数据对象，验证 COM 跨进程协商和 Shell 前台返回时间。 */
    private static void Receive(string root, string name)
    {
        NativeMethods.OleInitialize(IntPtr.Zero);
        try {
            IRunningObjectTable table;
            IMoniker moniker;
            Marshal.ThrowExceptionForHR(GetRunningObjectTable(0, out table));
            Marshal.ThrowExceptionForHR(CreateItemMoniker("!", name, out moniker));
            object value;
            Marshal.ThrowExceptionForHR(table.GetObject(moniker, out value));
            var data = (IDataObject)value;
            Guid iid = typeof(IShellItem).GUID;
            IShellItem item;
            Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(Path.Combine(root, "target"), null, ref iid, out item));
            Guid handler = new Guid("3981E225-F559-11D3-8E3A-00C04F6837D5");
            iid = typeof(IDropTarget).GUID;
            IntPtr pointer;
            Marshal.ThrowExceptionForHR(item.BindToHandler(null, ref handler, ref iid, out pointer));
            var drop = (IDropTarget)Marshal.GetObjectForIUnknown(pointer);
            Marshal.Release(pointer);
            uint effect = 1;
            var watch = Stopwatch.StartNew();
            Marshal.ThrowExceptionForHR(drop.DragEnter(data, 1, new NativePoint(), ref effect));
            Check(watch.ElapsedMilliseconds < 500 && effect == 1, "Cross-process hover blocked");
            long hover = watch.ElapsedMilliseconds;
            Marshal.ThrowExceptionForHR(drop.DragOver(1, new NativePoint(), ref effect));
            watch.Restart();
            Marshal.ThrowExceptionForHR(drop.Drop(data, 0, new NativePoint(), ref effect));
            Check(watch.ElapsedMilliseconds < 500, "Cross-process Drop blocked");
            Console.WriteLine("Cross-process Shell: hover=" + hover + "ms, drop=" + watch.ElapsedMilliseconds + "ms");
            while (!File.Exists(Path.Combine(root, "completed"))) Pump();
            Marshal.ReleaseComObject(drop);
            Marshal.ReleaseComObject(item);
            Marshal.ReleaseComObject(value);
            Marshal.ReleaseComObject(moniker);
            Marshal.ReleaseComObject(table);
        } finally { NativeMethods.OleUninitialize(); }
    }

    /// <summary>模拟可延迟和断开的 Electron 管道。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
    private sealed class Input : TextReader
    {
        internal readonly BlockingCollection<string> Lines = new BlockingCollection<string>();
        public override string ReadLine() { try { return Lines.Take(); } catch (InvalidOperationException) { return null; } }
    }
    /// <summary>捕获辅助程序协议。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
    private sealed class Output : TextWriter
    {
        public override Encoding Encoding { get { return Encoding.UTF8; } }
        internal Action<string> Handle;
        public override void WriteLine(string value) { Handle(value); }
    }
    /** 失败即退出，避免只记录输出而遗漏回归。 */
    private static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }

    /** 独立执行一个场景，后台线程设置硬超时保护。 */
    [STAThread]
    public static void Main(string[] args)
    {
        var log = Console.Out;
        new Thread(() => { Thread.Sleep(20000); log.WriteLine("FAIL: timeout"); Environment.Exit(9); }) { IsBackground = true }.Start();
        if (args[0] == "receive") { Receive(args[1], args[2]); return; }
        string scenario = args[1];
        bool directory = scenario.Contains("directory");
        bool cancel = scenario.EndsWith("-cancel", StringComparison.Ordinal);
        string source = Path.Combine(Path.GetFullPath(args[0]), "source");
        string target = Path.Combine(Path.GetFullPath(args[0]), "target");
        Directory.CreateDirectory(source);
        Directory.CreateDirectory(target);
        var input = new Input();
        var output = new Output();
        int requests = 0;
        int completedResult = int.MaxValue;
        uint completedEffects = uint.MaxValue;
        byte[] content = new byte[] { 0, 1, 2, 127, 128, 255 };
        Console.SetIn(input);
        Console.SetOut(output);
        output.Handle = line => {
            if (line.StartsWith("TRANSFER_END\t", StringComparison.Ordinal)) {
                completedResult = int.Parse(line.Split('\t')[1]);
                completedEffects = uint.Parse(line.Split('\t')[2]);
            }
            if (!line.StartsWith("REQUEST", StringComparison.Ordinal)) return;
            Interlocked.Increment(ref requests);
            ThreadPool.QueueUserWorkItem(_ => {
                Thread.Sleep(600);
                if (cancel) { input.Lines.Add("CANCEL"); return; }
                if (scenario == "disconnect") { input.Lines.CompleteAdding(); return; }
                if (scenario == "failure") { input.Lines.Add("ERROR\t0\t" + Program.Encode("remote read failed")); return; }
                if (line == "REQUEST_MANIFEST") {
                    var expanded = new List<DragItem> {
                        new DragItem { Index = 0, Name = "folder", IsDirectory = true },
                        new DragItem { Index = 1, Name = "folder\\空目录", IsDirectory = true }
                    };
                    if (scenario != "directory-empty") {
                        expanded.Add(new DragItem { Index = 2, Name = "folder\\文件.bin", Size = content.Length });
                        expanded.Add(new DragItem { Index = 3, Name = "folder\\zero.txt", Size = 0 });
                    }
                    File.WriteAllText(Path.Combine(source, "expanded-items.json"), new JavaScriptSerializer().Serialize(expanded));
                    input.Lines.Add("MANIFEST_READY");
                } else {
                    int index = int.Parse(line.Split('\t')[1]);
                    File.WriteAllBytes(Path.Combine(source, index + ".data"), index == 3 ? new byte[0] : content);
                    input.Lines.Add("READY\t" + index);
                }
            });
        };
        NativeMethods.OleInitialize(IntPtr.Zero);
        try {
            using (var protocol = new TransferProtocol(source)) {
                protocol.Start();
                var items = new List<DragItem> { new DragItem { Index = 0, Name = directory ? "folder" : "file.bin", IsDirectory = directory, Size = directory ? 0 : content.Length } };
                using (var data = new VirtualFileDataObject(items, directory, protocol)) {
                    // 未协商异步的内容请求必须立即失败，不能在悬停时下载或返回空文件。
                    var format = new FORMATETC { cfFormat = unchecked((short)NativeMethods.RegisterClipboardFormat("FileContents")), dwAspect = DVASPECT.DVASPECT_CONTENT, tymed = TYMED.TYMED_ISTREAM, lindex = 0 };
                    var watch = Stopwatch.StartNew();
                    try { STGMEDIUM ignored; data.GetData(ref format, out ignored); throw new Exception("Synchronous extraction accepted"); }
                    catch (COMException error) { Check(error.ErrorCode == unchecked((int)0x8000000A), "Unexpected synchronous error"); }
                    Check(watch.ElapsedMilliseconds < 500 && requests == 0, "Hover content request blocked");
                    if (scenario == "failure" || scenario == "disconnect" || scenario == "repeat") {
                        data.StartOperation(null);
                        if (scenario == "repeat") {
                            string first = protocol.PrepareItem(0);
                            string second = protocol.PrepareItem(0);
                            Check(first == second && requests == 1, "Repeated extraction downloaded twice");
                        } else {
                            try { protocol.PrepareItem(0); throw new Exception("Expected failure"); }
                            catch (IOException error) { Check(error.Message.Contains(scenario == "failure" ? "remote read failed" : "ended"), "Failure not propagated"); }
                        }
                        data.EndOperation(0, null, 1);
                    } else if (scenario.StartsWith("cross-", StringComparison.Ordinal)) {
                        IRunningObjectTable table;
                        IMoniker moniker;
                        Marshal.ThrowExceptionForHR(GetRunningObjectTable(0, out table));
                        string name = "termio-drag-test-" + Guid.NewGuid().ToString("N");
                        Marshal.ThrowExceptionForHR(CreateItemMoniker("!", name, out moniker));
                        int registration = table.Register(1, data, moniker);
                        try {
                            var start = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location,
                                "receive \"" + Path.GetFullPath(args[0]) + "\" " + name) {
                                UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                            };
                            using (var receiver = Process.Start(start)) {
                                while (completedResult == int.MaxValue && !receiver.HasExited) Pump();
                                Check(completedResult == 0, "Cross-process Shell did not complete");
                                data.WaitForCompletion();
                                File.WriteAllText(Path.Combine(args[0], "completed"), "ok");
                                while (!receiver.HasExited) Pump();
                                log.Write(receiver.StandardOutput.ReadToEnd());
                                Check(receiver.ExitCode == 0, receiver.StandardError.ReadToEnd());
                            }
                            string destination = Path.Combine(target, directory ? "folder\\文件.bin" : "file.bin");
                            Check(Convert.ToBase64String(File.ReadAllBytes(destination)) == Convert.ToBase64String(content), "Cross-process content differs");
                        } finally {
                            table.Revoke(registration);
                            Marshal.ReleaseComObject(moniker);
                            Marshal.ReleaseComObject(table);
                        }
                    } else {
                        Guid iid = typeof(IShellItem).GUID;
                        IShellItem shellItem;
                        Marshal.ThrowExceptionForHR(SHCreateItemFromParsingName(target, null, ref iid, out shellItem));
                        Guid handler = new Guid("3981E225-F559-11D3-8E3A-00C04F6837D5");
                        iid = typeof(IDropTarget).GUID;
                        IntPtr pointer;
                        Marshal.ThrowExceptionForHR(shellItem.BindToHandler(null, ref handler, ref iid, out pointer));
                        var drop = (IDropTarget)Marshal.GetObjectForIUnknown(pointer);
                        Marshal.Release(pointer);
                        try {
                            uint effect = 1;
                            watch.Restart();
                            Marshal.ThrowExceptionForHR(drop.DragEnter(data, 1, new NativePoint(), ref effect));
                            Check(watch.ElapsedMilliseconds < 500 && effect == 1 && requests == 0, "DragEnter blocked or accessed remote data");
                            long enterMs = watch.ElapsedMilliseconds;
                            for (int i = 0; i < 5; i++) {
                                watch.Restart();
                                Marshal.ThrowExceptionForHR(drop.DragOver(1, new NativePoint(), ref effect));
                                Check(watch.ElapsedMilliseconds < 500 && requests == 0, "DragOver blocked or accessed remote data");
                            }
                            if (scenario == "hover-cancel") {
                                Marshal.ThrowExceptionForHR(drop.DragLeave());
                                Check(requests == 0 && Directory.GetFileSystemEntries(target).Length == 0, "Cancelled hover left content");
                            } else {
                                watch.Restart();
                                Marshal.ThrowExceptionForHR(drop.Drop(data, 0, new NativePoint(), ref effect));
                                bool active; data.InOperation(out active);
                                Check(active && watch.ElapsedMilliseconds < 500, "Drop did not return asynchronously");
                                long dropMs = watch.ElapsedMilliseconds;
                                data.WaitForCompletion();
                                log.WriteLine("Shell " + scenario + ": hover=" + enterMs + "ms, drop=" + dropMs + "ms, background=" + watch.ElapsedMilliseconds + "ms");
                                if (cancel) {
                                    log.WriteLine("Cancel result=" + completedResult + ", effects=" + completedEffects);
                                    Check(completedResult < 0 || completedEffects == 0, "Cancellation reported as success");
                                    Check(!File.Exists(Path.Combine(target, directory ? "folder\\文件.bin" : "file.bin")), "Cancelled content left a partial file");
                                }
                                else {
                                    Check(completedResult == 0, "Missing Shell completion");
                                    if (directory) Check(Directory.Exists(Path.Combine(target, "folder", "空目录")), "Empty or Unicode directory lost");
                                    if (scenario != "directory-empty") {
                                        string destination = Path.Combine(target, directory ? "folder\\文件.bin" : "file.bin");
                                        Check(Convert.ToBase64String(File.ReadAllBytes(destination)) == Convert.ToBase64String(content), "File content differs");
                                        if (directory) Check(new FileInfo(Path.Combine(target, "folder", "zero.txt")).Length == 0, "Empty file lost");
                                    }
                                }
                            }
                        } finally { Marshal.ReleaseComObject(drop); Marshal.ReleaseComObject(shellItem); }
                    }
                }
                if (!input.Lines.IsAddingCompleted) input.Lines.CompleteAdding();
            }
            log.WriteLine("PASS: " + scenario);
        } finally { NativeMethods.OleUninitialize(); Console.SetOut(log); }
    }
}
