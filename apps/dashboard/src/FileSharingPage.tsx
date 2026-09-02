import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  Archive,
  CheckCircle2,
  Clipboard,
  Download,
  File as FileIcon,
  FileImage,
  FileText,
  HardDrive,
  Link2,
  LoaderCircle,
  ShieldCheck,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { api, type SharedFile, type SharedFileSnapshot } from "./api";
import { Button, Empty, PageHeader, Progress } from "./components";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 || value >= 10 ? 0 : 1)} ${units[index]}`;
}

function absoluteDownloadUrl(path: string) {
  return new URL(path, window.location.origin).toString();
}

function FileGlyph({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <FileImage />;
  if (mimeType.startsWith("text/") || mimeType.includes("pdf"))
    return <FileText />;
  if (
    mimeType.includes("zip") ||
    mimeType.includes("rar") ||
    mimeType.includes("compressed")
  )
    return <Archive />;
  return <FileIcon />;
}

function uploadFile(
  file: File,
  onProgress: (progress: number) => void,
  onRequest: (request: XMLHttpRequest) => void,
): Promise<SharedFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    onRequest(xhr);
    xhr.open("POST", "/api/shared-files");
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader(
      "X-File-Type",
      file.type || "application/octet-stream",
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      let payload: { error?: string } & Partial<SharedFile> = {};
      try {
        payload = JSON.parse(xhr.responseText || "{}");
      } catch {
        /* A useful fallback is returned below. */
      }
      if (xhr.status === 401) window.dispatchEvent(new Event("auth-expired"));
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(payload.error || "Upload failed"));
        return;
      }
      resolve(payload as SharedFile);
    });
    xhr.addEventListener("error", () =>
      reject(new Error("Upload connection failed")),
    );
    xhr.addEventListener("abort", () =>
      reject(new Error("Upload was cancelled")),
    );
    xhr.send(file);
  });
}

export default function FileSharingPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef<XMLHttpRequest | null>(null);
  const [snapshot, setSnapshot] = useState<SharedFileSnapshot | null>(null);
  const [selected, setSelected] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [deletingId, setDeletingId] = useState("");
  const [latestLink, setLatestLink] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(showLoading = false) {
    if (showLoading) setLoading(true);
    try {
      setSnapshot(await api.get<SharedFileSnapshot>("/shared-files"));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Could not load files",
      );
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
    return () => {
      uploadRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!selected?.type.startsWith("image/")) {
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(selected);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [selected]);

  function clearSelectedFile() {
    setSelected(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function chooseFile(file?: File) {
    if (uploading) return;
    setError("");
    setLatestLink("");
    if (!file) {
      clearSelectedFile();
      return;
    }
    if (!file.size) {
      clearSelectedFile();
      setError("Empty files cannot be shared.");
      return;
    }
    if (snapshot && file.size > snapshot.usage.maxFileBytes) {
      clearSelectedFile();
      setError(
        `This file is larger than the ${formatBytes(snapshot.usage.maxFileBytes)} upload limit.`,
      );
      return;
    }
    setSelected(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files[0]);
  }

  function openPicker(event?: KeyboardEvent<HTMLDivElement>) {
    if (uploading) return;
    if (event && event.key !== "Enter" && event.key !== " ") return;
    event?.preventDefault();
    inputRef.current?.click();
  }

  async function upload() {
    if (!selected || uploading) return;
    setUploading(true);
    setUploadProgress(0);
    setError("");
    try {
      const uploaded = await uploadFile(
        selected,
        setUploadProgress,
        (request) => {
          uploadRequestRef.current = request;
        },
      );
      setLatestLink(absoluteDownloadUrl(uploaded.downloadPath));
      clearSelectedFile();
      await load();
      window.dispatchEvent(
        new CustomEvent("toast", { detail: "Download link created" }),
      );
    } catch (uploadError) {
      const cancelled =
        uploadError instanceof Error &&
        uploadError.message === "Upload was cancelled";
      if (cancelled) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        await load();
        window.dispatchEvent(
          new CustomEvent("toast", {
            detail: "Upload cancelled; vault refreshed",
          }),
        );
      } else {
        setError(
          uploadError instanceof Error ? uploadError.message : "Upload failed",
        );
      }
    } finally {
      uploadRequestRef.current = null;
      setUploading(false);
      setUploadProgress(0);
    }
  }

  async function copyLink(pathOrUrl: string) {
    try {
      const link = pathOrUrl.startsWith("http")
        ? pathOrUrl
        : absoluteDownloadUrl(pathOrUrl);
      await navigator.clipboard.writeText(link);
      window.dispatchEvent(
        new CustomEvent("toast", { detail: "Download link copied" }),
      );
    } catch {
      setError(
        "The browser could not copy the link. Open it and copy the URL.",
      );
    }
  }

  async function removeFile(file: SharedFile) {
    if (
      !window.confirm(
        `Delete ${file.originalName}? Its public download link will stop working immediately.`,
      )
    )
      return;
    setDeletingId(file.id);
    setError("");
    try {
      await api.send(`/shared-files/${file.id}`, "DELETE");
      await load();
      window.dispatchEvent(
        new CustomEvent("toast", { detail: "File and link deleted" }),
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error ? deleteError.message : "Delete failed",
      );
    } finally {
      setDeletingId("");
    }
  }

  const usage = snapshot?.usage;
  const usagePercent = usage
    ? Math.min(100, (usage.usedBytes / usage.quotaBytes) * 100)
    : 0;

  return (
    <section className="page file-share-page">
      <PageHeader
        eyebrow="Transfer vault"
        title="File sharing"
        subtitle="Drop a picture or file, then send its private-by-link download URL."
        actions={
          <span className="file-share-security">
            <ShieldCheck /> Attachment-only delivery
          </span>
        }
      />

      {error && (
        <div className="file-share-error" role="alert">
          <X /> <span>{error}</span>
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X />
          </button>
        </div>
      )}

      <div className="file-share-grid">
        <section className="share-upload-card card">
          <div
            className={`share-drop-zone ${dragging ? "dragging" : ""} ${selected ? "selected" : ""} ${uploading ? "uploading" : ""}`}
            role="button"
            tabIndex={0}
            aria-label="Choose a file to share"
            aria-disabled={uploading}
            onClick={() => openPicker()}
            onKeyDown={openPicker}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!uploading) setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node))
                setDragging(false);
            }}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              disabled={uploading}
              onChange={(event) => chooseFile(event.target.files?.[0])}
              tabIndex={-1}
            />
            {selected ? (
              <>
                <span className="selected-file-visual">
                  {previewUrl ? (
                    <img src={previewUrl} alt="Selected upload preview" />
                  ) : (
                    <FileGlyph mimeType={selected.type} />
                  )}
                </span>
                <div className="selected-file-copy">
                  <small>Ready to transfer</small>
                  <strong>{selected.name}</strong>
                  <span>
                    {formatBytes(selected.size)} · {selected.type || "File"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <span className="upload-orbit">
                  <UploadCloud />
                </span>
                <strong>
                  {dragging ? "Release to stage file" : "Drop file here"}
                </strong>
                <p>or click to browse this device</p>
                <small>
                  Any file type · up to{" "}
                  {formatBytes(usage?.maxFileBytes || 100 * 1024 * 1024)}
                </small>
              </>
            )}
          </div>

          <footer className="share-upload-footer">
            <div>
              <small>Public access model</small>
              <span>Anyone with the unguessable link can download.</span>
            </div>
            {selected && !uploading && (
              <Button
                variant="ghost"
                disabled={uploading}
                onClick={clearSelectedFile}
              >
                <X /> Clear
              </Button>
            )}
            {uploading && (
              <Button
                variant="ghost"
                disabled={uploadProgress >= 100}
                onClick={() => uploadRequestRef.current?.abort()}
              >
                <X /> {uploadProgress >= 100 ? "Finalizing" : "Cancel"}
              </Button>
            )}
            <Button
              disabled={!selected || uploading}
              onClick={() => void upload()}
            >
              {uploading ? <LoaderCircle className="spin" /> : <Link2 />}
              {uploading ? `${uploadProgress}%` : "Create link"}
            </Button>
          </footer>
          {uploading && (
            <Progress value={uploadProgress} label="File upload progress" />
          )}
        </section>

        <aside className="share-storage-card card">
          <header>
            <span>
              <HardDrive />
            </span>
            <div>
              <small>Workspace storage</small>
              <strong>{formatBytes(usage?.usedBytes || 0)}</strong>
            </div>
          </header>
          <Progress value={usagePercent} label="Workspace storage used" />
          <div className="share-storage-scale">
            <span>
              {usagePercent.toFixed(usagePercent >= 10 ? 0 : 1)}% used
            </span>
            <span>{formatBytes(usage?.quotaBytes || 2 * 1024 ** 3)} total</span>
          </div>
          <dl>
            <div>
              <dt>Files</dt>
              <dd>
                {usage?.fileCount || 0} / {usage?.maxFiles || 500}
              </dd>
            </div>
            <div>
              <dt>Free</dt>
              <dd>
                {formatBytes(
                  Math.max(
                    0,
                    (usage?.quotaBytes || 0) - (usage?.usedBytes || 0),
                  ),
                )}
              </dd>
            </div>
            <div>
              <dt>Per transfer</dt>
              <dd>{formatBytes(usage?.maxFileBytes || 100 * 1024 * 1024)}</dd>
            </div>
          </dl>
          <p>Links stay active until the file is deleted from this vault.</p>
        </aside>
      </div>

      {latestLink && (
        <section className="share-link-ready card">
          <CheckCircle2 />
          <div>
            <small>Download link ready</small>
            <code>{latestLink}</code>
          </div>
          <Button variant="secondary" onClick={() => void copyLink(latestLink)}>
            <Clipboard /> Copy link
          </Button>
          <a className="btn ghost" href={latestLink}>
            <Download /> Test download
          </a>
        </section>
      )}

      <section className="shared-file-ledger card">
        <header>
          <div>
            <small>Transfer ledger</small>
            <h2>Shared files</h2>
          </div>
          <span>{snapshot?.files.length || 0} visible</span>
        </header>
        {loading ? (
          <div className="shared-file-loading">
            <LoaderCircle className="spin" /> Loading shared files
          </div>
        ) : snapshot?.files.length ? (
          <div className="shared-file-list">
            {snapshot.files.map((file) => (
              <article key={file.id}>
                <span className="shared-file-icon">
                  <FileGlyph mimeType={file.mimeType} />
                </span>
                <div className="shared-file-name">
                  <strong title={file.originalName}>{file.originalName}</strong>
                  <small>{file.mimeType}</small>
                </div>
                <div className="shared-file-metric">
                  <small>Size</small>
                  <b>{formatBytes(file.sizeBytes)}</b>
                </div>
                <div className="shared-file-metric">
                  <small>Downloads</small>
                  <b>{file.downloadCount}</b>
                </div>
                <div className="shared-file-metric shared-file-date">
                  <small>{file.uploadedBy?.username || "Former member"}</small>
                  <b>{new Date(file.createdAt).toLocaleString()}</b>
                </div>
                <div className="shared-file-actions">
                  <button
                    onClick={() => void copyLink(file.downloadPath)}
                    aria-label={`Copy link for ${file.originalName}`}
                    title="Copy download link"
                  >
                    <Clipboard />
                  </button>
                  <a
                    href={file.downloadPath}
                    aria-label={`Download ${file.originalName}`}
                    title="Download file"
                  >
                    <Download />
                  </a>
                  {file.canDelete && (
                    <button
                      className="danger"
                      disabled={deletingId === file.id}
                      onClick={() => void removeFile(file)}
                      aria-label={`Delete ${file.originalName}`}
                      title="Delete file and revoke link"
                    >
                      {deletingId === file.id ? (
                        <LoaderCircle className="spin" />
                      ) : (
                        <Trash2 />
                      )}
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="No shared files yet"
            body="Your first generated download link will appear here."
            action={
              <Button
                variant="secondary"
                onClick={() => inputRef.current?.click()}
              >
                <UploadCloud /> Choose a file
              </Button>
            }
          />
        )}
      </section>
    </section>
  );
}
