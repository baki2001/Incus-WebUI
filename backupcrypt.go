package main

// Encrypted backup targets: each file is encrypted on the way out with age
// (https://age-encryption.org) and a passphrase, as a stream, so it needs no
// extra disk space. The files can be opened without the UI with
// `age -d file.tar.age > file.tar`.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"

	"filippo.io/age"
)

// ageWorkFactor is the scrypt cost of the passphrase: 2^16 takes about a
// tenth of a second and 64 MiB per file. The age tool reads any factor.
const ageWorkFactor = 16

// countWriter counts and hashes what passes through it.
type countWriter struct {
	n int64
	h interface{ Write([]byte) (int, error) }
}

func (c *countWriter) Write(b []byte) (int, error) {
	c.n += int64(len(b))
	return c.h.Write(b)
}

// putBackupFile writes r to the target as name, encrypted when the target has
// a passphrase. It returns the size and SHA-256 of the plain data.
func putBackupFile(ctx context.Context, st backupStore, name string, r io.Reader, pass string) (int64, string, error) {
	h := sha256.New()
	cw := &countWriter{h: h}
	src := io.TeeReader(r, cw)
	if pass == "" {
		_, err := st.put(ctx, name, src)
		return cw.n, hex.EncodeToString(h.Sum(nil)), err
	}
	rcp, err := age.NewScryptRecipient(pass)
	if err != nil {
		return 0, "", err
	}
	rcp.SetWorkFactor(ageWorkFactor)
	pr, pw := io.Pipe()
	go func() {
		w, err := age.Encrypt(pw, rcp)
		if err == nil {
			_, err = io.Copy(w, src)
			if cerr := w.Close(); err == nil {
				err = cerr
			}
		}
		pw.CloseWithError(err)
	}()
	_, err = st.put(ctx, name, pr)
	// Stops the encrypting goroutine if put gave up before the end.
	pr.CloseWithError(errors.New("upload ended"))
	return cw.n, hex.EncodeToString(h.Sum(nil)), err
}

// openBackupFile reads a file from a target, decrypting it when it was
// stored encrypted.
func openBackupFile(ctx context.Context, st backupStore, name string, encrypted bool, pass string) (io.ReadCloser, error) {
	rc, err := st.get(ctx, name)
	if err != nil || !encrypted {
		return rc, err
	}
	if pass == "" {
		rc.Close()
		return nil, errors.New("this backup is encrypted, and its target has no passphrase now. Set the passphrase it was made with")
	}
	id, err := age.NewScryptIdentity(pass)
	if err != nil {
		rc.Close()
		return nil, err
	}
	dr, err := age.Decrypt(rc, id)
	if err != nil {
		rc.Close()
		if strings.Contains(err.Error(), "incorrect passphrase") || strings.Contains(err.Error(), "no identity matched") {
			return nil, errors.New("the target's passphrase is not the one this backup was made with")
		}
		return nil, err
	}
	return struct {
		io.Reader
		io.Closer
	}{dr, rc}, nil
}
