using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace MyTerminal.VirtualFileDrag
{
    internal static class Program
    {
        private const uint DropEffectCopy = 1;

        [STAThread]
        private static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 1 && args[0] == "--switch-english-input")
            {
                IntPtr foregroundWindow = NativeMethods.GetForegroundWindow();
                IntPtr imeWindow = NativeMethods.ImmGetDefaultIMEWnd(foregroundWindow);
                if (imeWindow == IntPtr.Zero)
                {
                    return 1;
                }
                NativeMethods.SendMessage(imeWindow, 0x0283, new IntPtr(2), IntPtr.Zero);
                return 0;
            }
            if (args.Length != 1 || !File.Exists(args[0]))
            {
                WriteProtocolLine("ERROR\tmanifest-not-found");
                return 2;
            }

            DragManifest manifest;
            try
            {
                string json = File.ReadAllText(args[0], Encoding.UTF8);
                manifest = new JavaScriptSerializer().Deserialize<DragManifest>(json);
                bool hasVirtualFiles = manifest != null && manifest.Items != null && manifest.Items.Count > 0;
                if (!hasVirtualFiles)
                {
                    throw new InvalidDataException("The drag manifest is empty.");
                }
            }
            catch (Exception error)
            {
                WriteProtocolLine("ERROR\t" + Encode(error.Message));
                return 3;
            }

            int initializeResult = NativeMethods.OleInitialize(IntPtr.Zero);
            if (initializeResult < 0)
            {
                WriteProtocolLine("ERROR\t" + Encode("OleInitialize failed: 0x" + initializeResult.ToString("X8")));
                return 4;
            }

            TransferProtocol protocol = null;
            VirtualFileDataObject dataObject = null;
            MouseInputRelay mouseRelay = null;
            try
            {
                long sourceWindowValue;
                IntPtr sourceWindow = long.TryParse(manifest.SourceWindowHandle, out sourceWindowValue)
                    ? new IntPtr(sourceWindowValue)
                    : IntPtr.Zero;
                mouseRelay = new MouseInputRelay(sourceWindow);
                protocol = new TransferProtocol(manifest.TempRoot);
                protocol.Start();
                dataObject = new VirtualFileDataObject(manifest.Items, manifest.ExpandDirectories, protocol);
                mouseRelay.Start();
                uint effect;
                WriteProtocolLine("DRAGGING");
                int result = NativeMethods.DoDragDrop(dataObject, new DropSource(mouseRelay), DropEffectCopy, out effect);
                mouseRelay.Dispose();
                WriteProtocolLine("DROPPED\t" + effect);
                dataObject.WaitForCompletion();
                WriteProtocolLine("END\t" + result + "\t" + effect);
                return result == NativeMethods.DragDropSCancel || result == NativeMethods.DragDropSDrop ? 0 : 5;
            }
            catch (Exception error)
            {
                WriteProtocolLine("ERROR\t" + Encode(error.Message));
                return 6;
            }
            finally
            {
                if (dataObject != null)
                {
                    dataObject.Dispose();
                }
                if (mouseRelay != null)
                {
                    mouseRelay.Dispose();
                }
                if (protocol != null)
                {
                    protocol.Dispose();
                }
                NativeMethods.OleUninitialize();
            }
        }

        internal static void WriteProtocolLine(string line)
        {
            lock (Console.Out)
            {
                Console.Out.WriteLine(line);
                Console.Out.Flush();
            }
        }

        internal static string Encode(string value)
        {
            return Convert.ToBase64String(Encoding.UTF8.GetBytes(value ?? string.Empty));
        }
    }

    internal sealed class MouseInputRelay : IDisposable
    {
        private readonly uint dragThreadId;
        private readonly Thread relayThread;
        private readonly IntPtr sourceWindow;
        private volatile bool stopped;
        private volatile bool returnedToSource;
        private bool hasLeftSource;

        public MouseInputRelay(IntPtr sourceWindowValue)
        {
            sourceWindow = sourceWindowValue;
            NativeMessage ignored;
            NativeMethods.PeekMessage(out ignored, IntPtr.Zero, 0, 0, 0);
            dragThreadId = NativeMethods.GetCurrentThreadId();
            relayThread = new Thread(RelayMouseState);
            relayThread.IsBackground = true;
            relayThread.Name = "my-terminal-drag-mouse-relay";
        }

        public void Start()
        {
            relayThread.Start();
        }

        public bool ReturnedToSource
        {
            get { return returnedToSource; }
        }

        private void RelayMouseState()
        {
            while (!stopped)
            {
                bool leftDown = (NativeMethods.GetAsyncKeyState(NativeMethods.VirtualKeyLeftButton) & 0x8000) != 0;
                NativePoint point;
                NativeMethods.GetCursorPos(out point);
                if (sourceWindow != IntPtr.Zero)
                {
                    IntPtr hoveredWindow = NativeMethods.WindowFromPoint(point);
                    IntPtr hoveredRoot = hoveredWindow == IntPtr.Zero
                        ? IntPtr.Zero
                        : NativeMethods.GetAncestor(hoveredWindow, NativeMethods.GetAncestorRoot);
                    if (hoveredRoot != sourceWindow)
                    {
                        hasLeftSource = true;
                    }
                    else if (leftDown && hasLeftSource && !returnedToSource)
                    {
                        returnedToSource = true;
                        Program.WriteProtocolLine("RETURNED");
                    }
                }
                uint message = leftDown ? NativeMethods.WindowMessageMouseMove : NativeMethods.WindowMessageLeftButtonUp;
                UIntPtr keyState = leftDown ? new UIntPtr(NativeMethods.MouseKeyLeft) : UIntPtr.Zero;
                int coordinates = (point.x & 0xffff) | ((point.y & 0xffff) << 16);
                NativeMethods.PostThreadMessage(dragThreadId, message, keyState, new IntPtr(coordinates));
                if (!leftDown) return;
                Thread.Sleep(12);
            }
        }

        public void Dispose()
        {
            stopped = true;
        }
    }

    internal sealed class DragManifest
    {
        public string TempRoot { get; set; }
        public string SourceWindowHandle { get; set; }
        public List<DragItem> Items { get; set; }
        public bool ExpandDirectories { get; set; }
    }

    internal sealed class DragItem
    {
        public int Index { get; set; }
        public string Name { get; set; }
        public bool IsDirectory { get; set; }
        public long Size { get; set; }
    }

    internal sealed class TransferProtocol : IDisposable
    {
        private sealed class PendingTransfer
        {
            public readonly ManualResetEvent Completed = new ManualResetEvent(false);
            public string Error;
        }

        private readonly string tempRoot;
        private readonly Dictionary<int, PendingTransfer> pending = new Dictionary<int, PendingTransfer>();
        private readonly object sync = new object();
        private readonly ManualResetEvent manifestReady = new ManualResetEvent(false);
        private Thread readerThread;
        private volatile bool disposed;
        private volatile bool cancelled;
        private bool manifestRequested;
        private string manifestError;
        private volatile string terminalError;

        /** 传输进程关闭后，消息泵不能继续无期限等待 Shell。 */
        public bool IsClosed { get { return disposed || terminalError != null; } }
        /** Shell 有时将已跳过的取消请求按成功结束，必须保留源端取消状态。 */
        public bool IsCancelled { get { return cancelled; } }

        public TransferProtocol(string tempRootValue)
        {
            if (string.IsNullOrWhiteSpace(tempRootValue))
            {
                throw new InvalidDataException("A transfer temp directory is required.");
            }
            tempRoot = Path.GetFullPath(tempRootValue);
            Directory.CreateDirectory(tempRoot);
        }

        public void Start()
        {
            readerThread = new Thread(ReadResponses);
            readerThread.IsBackground = true;
            readerThread.Name = "my-terminal-drag-protocol";
            readerThread.Start();
        }

        public string PrepareItem(int index)
        {
            string localPath = Path.Combine(tempRoot, index.ToString() + ".data");
            PendingTransfer transfer;
            bool request = false;
            lock (sync)
            {
                if (cancelled) throw new COMException("拖拽下载已取消", NativeMethods.ErrorCancelled);
                if (IsClosed) throw new IOException(terminalError ?? "下载进程已结束");
                if (!pending.TryGetValue(index, out transfer)) {
                    transfer = new PendingTransfer();
                    pending.Add(index, transfer);
                    request = true;
                }
            }

            if (request) Program.WriteProtocolLine("REQUEST\t" + index);
            if (!transfer.Completed.WaitOne(TimeSpan.FromHours(12)))
            {
                throw new TimeoutException("Timed out while waiting for SFTP content.");
            }
            if (cancelled) throw new COMException("拖拽下载已取消", NativeMethods.ErrorCancelled);
            if (!string.IsNullOrEmpty(transfer.Error))
            {
                throw new IOException(transfer.Error);
            }
            return localPath;
        }

        /** 只在后台提取阶段展开目录；悬停始终使用初始根条目。 */
        public List<DragItem> PrepareManifest()
        {
            lock (sync) {
                if (cancelled) throw new COMException("拖拽下载已取消", NativeMethods.ErrorCancelled);
                if (IsClosed) throw new IOException(terminalError ?? "下载进程已结束");
                if (!manifestRequested) {
                    manifestRequested = true;
                    Program.WriteProtocolLine("REQUEST_MANIFEST");
                }
            }
            if (!manifestReady.WaitOne(TimeSpan.FromHours(12)))
            {
                throw new TimeoutException("读取远端目录超时");
            }
            if (cancelled) throw new COMException("拖拽下载已取消", NativeMethods.ErrorCancelled);
            if (!string.IsNullOrEmpty(manifestError)) throw new IOException(manifestError);
            var serializer = new JavaScriptSerializer { MaxJsonLength = 64 * 1024 * 1024 };
            return serializer.Deserialize<List<DragItem>>(File.ReadAllText(Path.Combine(tempRoot, "expanded-items.json"), Encoding.UTF8));
        }

        private void ReadResponses()
        {
            try
            {
                string line;
                while (!disposed && (line = Console.In.ReadLine()) != null)
                {
                    if (line == "CANCEL") {
                        cancelled = true;
                        FailAll("拖拽下载已取消", false);
                        continue;
                    }
                    if (line == "MANIFEST_READY")
                    {
                        manifestReady.Set();
                        continue;
                    }
                    if (line.StartsWith("MANIFEST_ERROR\t", StringComparison.Ordinal))
                    {
                        manifestError = Decode(line.Substring("MANIFEST_ERROR\t".Length));
                        manifestReady.Set();
                        continue;
                    }
                    string[] parts = line.Split(new[] { '\t' }, 3);
                    if (parts.Length < 2) continue;
                    int index;
                    if (!int.TryParse(parts[1], out index) || index < 0 || index >= 50000) continue;
                    if (parts[0] != "READY" && parts[0] != "ERROR") continue;
                    PendingTransfer transfer;
                    lock (sync)
                    {
                        if (!pending.TryGetValue(index, out transfer)) {
                            transfer = new PendingTransfer();
                            pending.Add(index, transfer);
                        }
                        if (transfer.Completed.WaitOne(0)) continue;
                        if (parts[0] == "ERROR") transfer.Error = parts.Length >= 3 ? Decode(parts[2]) : "SFTP download failed.";
                        transfer.Completed.Set();
                    }
                }
            }
            catch (Exception error)
            {
                FailAll(error.Message);
            }
            finally
            {
                FailAll("The Electron transfer process ended.");
            }
        }

        private static string Decode(string value)
        {
            try
            {
                return Encoding.UTF8.GetString(Convert.FromBase64String(value));
            }
            catch
            {
                return value;
            }
        }

        private void FailAll(string message, bool disconnected = true)
        {
            lock (sync)
            {
                if (disconnected) terminalError = message;
                manifestError = manifestError ?? message;
                manifestReady.Set();
                foreach (PendingTransfer transfer in pending.Values)
                {
                    if (transfer.Completed.WaitOne(0)) continue;
                    transfer.Error = message;
                    transfer.Completed.Set();
                }
            }
        }

        public void Dispose()
        {
            lock (sync)
            {
                if (disposed) return;
                disposed = true;
                FailAll("拖拽下载已取消");
            }
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class VirtualFileDataObject : IDataObject, IDataObjectAsyncCapability, IDisposable
    {
        private const int S_OK = 0;
        private const int E_NOTIMPL = unchecked((int)0x80004001);
        private const int DV_E_FORMATETC = unchecked((int)0x80040064);
        private const int DV_E_LINDEX = unchecked((int)0x80040068);
        private const uint FdAttributes = 0x00000004;
        private const uint FdFileSize = 0x00000040;
        private const uint FdUnicode = 0x80000000;
        private const uint FileAttributeDirectory = 0x00000010;
        private const uint FileAttributeNormal = 0x00000080;

        private List<DragItem> items;
        private bool expandDirectories;
        private readonly object manifestSync = new object();
        private readonly TransferProtocol protocol;
        private readonly short fileGroupDescriptorFormat;
        private readonly short fileContentsFormat;
        private readonly short preferredDropEffectFormat;
        private readonly List<IStream> openStreams = new List<IStream>();
        // 异步协商只负责生命周期；耗时内容请求由接收方后台线程发起。
        private volatile bool asyncMode = true;
        private volatile bool inOperation;
        private readonly ManualResetEvent operationEnded = new ManualResetEvent(false);
        private int operationFinished;

        /** 开启或关闭 Shell 异步提取协商。 */
        public int SetAsyncMode(bool enabled) { asyncMode = enabled; return S_OK; }

        /** 向接收方报告后台提取能力。 */
        public int GetAsyncMode(out bool enabled) { enabled = asyncMode; return S_OK; }

        /** 接收方开始后台提取，之后允许等待远端内容。 */
        public int StartOperation(IBindCtx reserved)
        {
            if (!asyncMode || operationFinished != 0) return E_NOTIMPL;
            inOperation = true;
            return S_OK;
        }

        /** 拖放返回后据此保留辅助进程。 */
        public int InOperation(out bool active) { active = inOperation; return S_OK; }

        /** 接收方完成复制或取消后释放后台生命周期。 */
        public int EndOperation(int result, IBindCtx reserved, uint effects)
        {
            if (Interlocked.Exchange(ref operationFinished, 1) != 0) return S_OK;
            if (protocol.IsCancelled) { result = NativeMethods.ErrorCancelled; effects = 0; }
            if (result < 0 && result != unchecked((int)0x800704C7) && result != unchecked((int)0x80004004)) Program.WriteProtocolLine("ERROR\t" + Program.Encode("拖拽下载未完成 (0x" + result.ToString("X8") + ")"));
            Program.WriteProtocolLine("TRANSFER_END\t" + result + "\t" + effects);
            inOperation = false;
            operationEnded.Set();
            return S_OK;
        }

        /** 保持 STA 消息泵运行，直到 Shell 完成异步复制。 */
        public void WaitForCompletion()
        {
            DateTime deadline = DateTime.UtcNow.AddHours(12);
            while (inOperation)
            {
                NativeMessage message;
                while (NativeMethods.PeekMessage(out message, IntPtr.Zero, 0, 0, 1))
                {
                    NativeMethods.TranslateMessage(ref message);
                    NativeMethods.DispatchMessage(ref message);
                }
                if (operationEnded.WaitOne(10)) break;
                if (protocol.IsClosed) throw new IOException("下载进程已结束");
                if (DateTime.UtcNow >= deadline) throw new TimeoutException("拖拽下载超时");
            }
        }

        public VirtualFileDataObject(List<DragItem> manifestItems, bool manifestExpandDirectories, TransferProtocol transferProtocol)
        {
            items = manifestItems ?? new List<DragItem>();
            expandDirectories = manifestExpandDirectories;
            protocol = transferProtocol;
            fileGroupDescriptorFormat = unchecked((short)NativeMethods.RegisterClipboardFormat("FileGroupDescriptorW"));
            fileContentsFormat = unchecked((short)NativeMethods.RegisterClipboardFormat("FileContents"));
            preferredDropEffectFormat = unchecked((short)NativeMethods.RegisterClipboardFormat("Preferred DropEffect"));
        }

        public void GetData(ref FORMATETC format, out STGMEDIUM medium)
        {
            if (format.cfFormat == fileGroupDescriptorFormat && Supports(format, TYMED.TYMED_HGLOBAL))
            {
                // 目录清单尚未展开时，不能把根条目伪装成可复制的空目录。
                if (expandDirectories && !inOperation) throw new COMException("目录内容将在松手后读取。", unchecked((int)0x8000000A));
                EnsureManifest();
                medium = CreateFileGroupDescriptor();
                return;
            }
            if (format.cfFormat == preferredDropEffectFormat && Supports(format, TYMED.TYMED_HGLOBAL))
            {
                medium = CreatePreferredDropEffect();
                return;
            }
            if (format.cfFormat == fileContentsFormat && Supports(format, TYMED.TYMED_ISTREAM))
            {
                if (!inOperation) throw new COMException("该位置暂不支持拖拽下载，请使用下载按钮。", unchecked((int)0x8000000A));
                EnsureManifest();
                if (format.lindex < 0 || format.lindex >= items.Count)
                {
                    throw new COMException("Invalid virtual file index.", DV_E_LINDEX);
                }
                DragItem item = items[format.lindex];
                if (item.IsDirectory)
                {
                    throw new COMException("Directories do not expose file contents.", DV_E_LINDEX);
                }
                string localPath = protocol.PrepareItem(item.Index);
                IStream stream;
                int createResult = NativeMethods.SHCreateStreamOnFileEx(
                    localPath,
                    NativeMethods.StorageModeRead | NativeMethods.StorageModeShareDenyWrite,
                    FileAttributeNormal,
                    false,
                    null,
                    out stream);
                if (createResult < 0 || stream == null)
                {
                    throw new COMException("Windows could not open the downloaded drag content.", createResult);
                }
                lock (openStreams) openStreams.Add(stream);
                medium = new STGMEDIUM
                {
                    tymed = TYMED.TYMED_ISTREAM,
                    unionmember = Marshal.GetComInterfaceForObject(stream, typeof(IStream)),
                    pUnkForRelease = null,
                };
                return;
            }
            throw new COMException("Unsupported clipboard format.", DV_E_FORMATETC);
        }

        public void GetDataHere(ref FORMATETC format, ref STGMEDIUM medium)
        {
            throw new COMException("GetDataHere is not supported.", E_NOTIMPL);
        }

        public int QueryGetData(ref FORMATETC format)
        {
            if (format.dwAspect != DVASPECT.DVASPECT_CONTENT) return DV_E_FORMATETC;
            if (format.cfFormat == fileGroupDescriptorFormat && Supports(format, TYMED.TYMED_HGLOBAL)) return S_OK;
            if (format.cfFormat == preferredDropEffectFormat && Supports(format, TYMED.TYMED_HGLOBAL)) return S_OK;
            if (format.cfFormat == fileContentsFormat && Supports(format, TYMED.TYMED_ISTREAM))
            {
                if (format.lindex == -1) return S_OK;
                return format.lindex >= 0 && format.lindex < items.Count && !items[format.lindex].IsDirectory
                    ? S_OK
                    : DV_E_LINDEX;
            }
            return DV_E_FORMATETC;
        }

        public int GetCanonicalFormatEtc(ref FORMATETC formatIn, out FORMATETC formatOut)
        {
            formatOut = formatIn;
            formatOut.ptd = IntPtr.Zero;
            return NativeMethods.DataSFormatEtc;
        }

        public void SetData(ref FORMATETC formatIn, ref STGMEDIUM medium, bool release)
        {
            // Shell 通过这些格式反馈复制结果和拖放提示，数据生命周期由异步完成通知控制。
            if (release)
            {
                NativeMethods.ReleaseStgMedium(ref medium);
                medium.tymed = TYMED.TYMED_NULL;
                medium.unionmember = IntPtr.Zero;
                medium.pUnkForRelease = null;
            }
        }

        public IEnumFORMATETC EnumFormatEtc(DATADIR direction)
        {
            if (direction != DATADIR.DATADIR_GET)
            {
                throw new COMException("Only DATADIR_GET is supported.", E_NOTIMPL);
            }
            FORMATETC[] formats = new[]
                {
                    CreateFormat(fileGroupDescriptorFormat, -1, TYMED.TYMED_HGLOBAL),
                    CreateFormat(fileContentsFormat, -1, TYMED.TYMED_ISTREAM),
                    CreateFormat(preferredDropEffectFormat, -1, TYMED.TYMED_HGLOBAL),
                };
            return new FormatEnumerator(formats);
        }

        public int DAdvise(ref FORMATETC pFormatetc, ADVF advf, IAdviseSink adviseSink, out int connection)
        {
            connection = 0;
            return NativeMethods.OleEAdvisenotSupported;
        }

        public void DUnadvise(int connection)
        {
            throw new COMException("Advisory connections are not supported.", NativeMethods.OleEAdvisenotSupported);
        }

        public int EnumDAdvise(out IEnumSTATDATA enumAdvise)
        {
            enumAdvise = null;
            return NativeMethods.OleEAdvisenotSupported;
        }

        private static bool Supports(FORMATETC format, TYMED tymed)
        {
            return format.dwAspect == DVASPECT.DVASPECT_CONTENT && (format.tymed & tymed) != 0;
        }

        private static FORMATETC CreateFormat(short format, int index, TYMED tymed)
        {
            return new FORMATETC
            {
                cfFormat = format,
                dwAspect = DVASPECT.DVASPECT_CONTENT,
                lindex = index,
                ptd = IntPtr.Zero,
                tymed = tymed,
            };
        }

        /** 完整目录只在异步后台请求中加载，避免拖放悬停等待远端。 */
        private void EnsureManifest()
        {
            if (!inOperation || !expandDirectories) return;
            lock (manifestSync) {
                if (!expandDirectories) return;
                items = protocol.PrepareManifest();
                expandDirectories = false;
            }
        }

        private STGMEDIUM CreateFileGroupDescriptor()
        {
            int descriptorSize = Marshal.SizeOf(typeof(FileDescriptorW));
            int totalSize = sizeof(uint) + descriptorSize * items.Count;
            IntPtr handle = NativeMethods.GlobalAlloc(NativeMethods.GMemMoveable | NativeMethods.GMemZeroInit, new UIntPtr((uint)totalSize));
            if (handle == IntPtr.Zero) throw new OutOfMemoryException();
            IntPtr memory = NativeMethods.GlobalLock(handle);
            if (memory == IntPtr.Zero)
            {
                NativeMethods.GlobalFree(handle);
                throw new OutOfMemoryException();
            }
            try
            {
                Marshal.WriteInt32(memory, items.Count);
                for (int index = 0; index < items.Count; index++)
                {
                    DragItem item = items[index];
                    ulong size = item.Size < 0 ? 0UL : (ulong)item.Size;
                    FileDescriptorW descriptor = new FileDescriptorW
                    {
                        dwFlags = FdAttributes | FdUnicode | (item.IsDirectory ? 0U : FdFileSize),
                        dwFileAttributes = item.IsDirectory ? FileAttributeDirectory : FileAttributeNormal,
                        nFileSizeHigh = (uint)(size >> 32),
                        nFileSizeLow = (uint)(size & 0xffffffff),
                        cFileName = item.Name ?? "download",
                    };
                    IntPtr target = IntPtr.Add(memory, sizeof(uint) + descriptorSize * index);
                    Marshal.StructureToPtr(descriptor, target, false);
                }
            }
            finally
            {
                NativeMethods.GlobalUnlock(handle);
            }
            return new STGMEDIUM { tymed = TYMED.TYMED_HGLOBAL, unionmember = handle, pUnkForRelease = null };
        }

        private static STGMEDIUM CreatePreferredDropEffect()
        {
            IntPtr handle = NativeMethods.GlobalAlloc(NativeMethods.GMemMoveable | NativeMethods.GMemZeroInit, new UIntPtr(sizeof(uint)));
            if (handle == IntPtr.Zero) throw new OutOfMemoryException();
            IntPtr memory = NativeMethods.GlobalLock(handle);
            if (memory == IntPtr.Zero)
            {
                NativeMethods.GlobalFree(handle);
                throw new OutOfMemoryException();
            }
            Marshal.WriteInt32(memory, 1);
            NativeMethods.GlobalUnlock(handle);
            return new STGMEDIUM { tymed = TYMED.TYMED_HGLOBAL, unionmember = handle, pUnkForRelease = null };
        }

        public void Dispose()
        {
            lock (openStreams) {
                foreach (IStream stream in openStreams) {
                    if (Marshal.IsComObject(stream)) Marshal.FinalReleaseComObject(stream);
                }
                openStreams.Clear();
            }
        }

    }

    internal sealed class FormatEnumerator : IEnumFORMATETC
    {
        private readonly FORMATETC[] formats;
        private int index;

        public FormatEnumerator(FORMATETC[] source)
        {
            formats = source;
        }

        public int Next(int count, FORMATETC[] result, int[] fetched)
        {
            int copied = 0;
            while (copied < count && index < formats.Length)
            {
                result[copied] = formats[index];
                copied++;
                index++;
            }
            if (fetched != null && fetched.Length > 0) fetched[0] = copied;
            return copied == count ? 0 : 1;
        }

        public int Skip(int count)
        {
            index = Math.Min(formats.Length, index + count);
            return index < formats.Length ? 0 : 1;
        }

        public int Reset()
        {
            index = 0;
            return 0;
        }

        public void Clone(out IEnumFORMATETC clone)
        {
            FormatEnumerator next = new FormatEnumerator(formats);
            next.index = index;
            clone = next;
        }
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    internal sealed class DropSource : IDropSource
    {
        private readonly MouseInputRelay mouseRelay;

        public DropSource(MouseInputRelay relay)
        {
            mouseRelay = relay;
        }

        public int QueryContinueDrag(bool escapePressed, uint keyState)
        {
            if (escapePressed || mouseRelay.ReturnedToSource) return NativeMethods.DragDropSCancel;
            if ((keyState & NativeMethods.MouseKeyLeft) == 0) return NativeMethods.DragDropSDrop;
            return 0;
        }

        public int GiveFeedback(uint effect)
        {
            return NativeMethods.DragDropSUseDefaultCursors;
        }
    }

    [ComImport]
    [Guid("00000121-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IDropSource
    {
        [PreserveSig]
        int QueryContinueDrag([MarshalAs(UnmanagedType.Bool)] bool escapePressed, uint keyState);

        [PreserveSig]
        int GiveFeedback(uint effect);
    }

    /// <summary>Windows 后台数据提取协商。作者：chenjd；创建时间：2026-09-24 15:00:00。</summary>
    [ComVisible(true)]
    [Guid("3D8B0590-F691-11D2-8EA9-006097DF5BD4")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IDataObjectAsyncCapability
    {
        /// <summary>设置异步模式。</summary>
        [PreserveSig] int SetAsyncMode([MarshalAs(UnmanagedType.Bool)] bool enabled);
        /// <summary>查询异步模式。</summary>
        [PreserveSig] int GetAsyncMode([MarshalAs(UnmanagedType.Bool)] out bool enabled);
        /// <summary>开始异步提取。</summary>
        [PreserveSig] int StartOperation(IBindCtx reserved);
        /// <summary>查询后台操作状态。</summary>
        [PreserveSig] int InOperation([MarshalAs(UnmanagedType.Bool)] out bool active);
        /// <summary>结束异步提取。</summary>
        [PreserveSig] int EndOperation(int result, IBindCtx reserved, uint effects);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SizeL
    {
        public int cx;
        public int cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PointL
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativePoint
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeMessage
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public NativePoint point;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode, Pack = 4)]
    internal struct FileDescriptorW
    {
        public uint dwFlags;
        public Guid clsid;
        public SizeL sizel;
        public PointL pointl;
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string cFileName;
    }

    internal static class NativeMethods
    {
        internal const int DragDropSDrop = 0x00040100;
        internal const int DragDropSCancel = 0x00040101;
        internal const int DragDropSUseDefaultCursors = 0x00040102;
        internal const int DataSFormatEtc = 0x00040130;
        internal const int OleEAdvisenotSupported = unchecked((int)0x80040003);
        internal const int ErrorCancelled = unchecked((int)0x800704C7);
        internal const uint MouseKeyLeft = 0x0001;
        internal const int VirtualKeyLeftButton = 0x01;
        internal const uint WindowMessageMouseMove = 0x0200;
        internal const uint WindowMessageLeftButtonUp = 0x0202;
        internal const uint GMemMoveable = 0x0002;
        internal const uint GMemZeroInit = 0x0040;
        internal const uint StorageModeRead = 0x00000000;
        internal const uint StorageModeShareDenyWrite = 0x00000020;
        internal const uint GetAncestorRoot = 2;

        [DllImport("ole32.dll")]
        internal static extern int OleInitialize(IntPtr reserved);

        [DllImport("ole32.dll")]
        internal static extern void OleUninitialize();

        [DllImport("ole32.dll")]
        internal static extern void ReleaseStgMedium(ref STGMEDIUM medium);

        [DllImport("ole32.dll")]
        internal static extern int DoDragDrop(
            [In, MarshalAs(UnmanagedType.Interface)] IDataObject dataObject,
            [In, MarshalAs(UnmanagedType.Interface)] IDropSource dropSource,
            uint allowedEffects,
            out uint effect);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint RegisterClipboardFormat(string format);

        [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
        internal static extern int SHCreateStreamOnFileEx(
            string fileName,
            uint mode,
            uint attributes,
            [MarshalAs(UnmanagedType.Bool)] bool create,
            IStream template,
            out IStream stream);

        [DllImport("kernel32.dll")]
        internal static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        internal static extern short GetAsyncKeyState(int virtualKey);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("imm32.dll")]
        internal static extern IntPtr ImmGetDefaultIMEWnd(IntPtr window);

        [DllImport("user32.dll")]
        internal static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetCursorPos(out NativePoint point);

        [DllImport("user32.dll")]
        internal static extern IntPtr WindowFromPoint(NativePoint point);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetAncestor(IntPtr window, uint flags);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PostThreadMessage(uint threadId, uint message, UIntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool PeekMessage(out NativeMessage message, IntPtr window, uint min, uint max, uint remove);

        [DllImport("user32.dll")]
        internal static extern bool TranslateMessage(ref NativeMessage message);

        [DllImport("user32.dll")]
        internal static extern IntPtr DispatchMessage(ref NativeMessage message);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalLock(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GlobalUnlock(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr GlobalFree(IntPtr handle);
    }
}
