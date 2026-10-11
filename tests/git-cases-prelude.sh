export GIT_AUTHOR_NAME=Ann GIT_AUTHOR_EMAIL=ann@example.com GIT_COMMITTER_NAME=Ann GIT_COMMITTER_EMAIL=ann@example.com
export GIT_AUTHOR_DATE='1700000000 +0000' GIT_COMMITTER_DATE='1700000000 +0000'
r() { git init -q -b main && git add -A && git commit -qm init; }
