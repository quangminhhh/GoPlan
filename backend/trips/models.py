from __future__ import annotations

import uuid

from django.conf import settings
from django.core.validators import MaxValueValidator, MinValueValidator
from django.db import models
from django.db.models import F, Q


CHAT_CHANGE_SEQUENCE_MAX = 9_007_199_254_740_991


# -------- Status / Role Choices --------

class TripStatus(models.TextChoices):
    PLANNING   = "PLANNING",   "Planning"
    ONGOING    = "ONGOING",    "Ongoing"
    COMPLETED  = "COMPLETED",  "Completed"
    CANCELLED  = "CANCELLED",  "Cancelled"


class TripRole(models.TextChoices):
    CAPTAIN = "CAPTAIN", "Captain"
    MEMBER  = "MEMBER",  "Member"


class MemberStatus(models.TextChoices):
    ACTIVE  = "ACTIVE",  "Active"
    LEFT    = "LEFT",    "Left"
    REMOVED = "REMOVED", "Removed"


class InvitationStatus(models.TextChoices):
    PENDING   = "PENDING",   "Pending"
    ACCEPTED  = "ACCEPTED",  "Accepted"
    DECLINED  = "DECLINED",  "Declined"
    CANCELLED = "CANCELLED", "Cancelled"


class TimelineActivityTimeMode(models.TextChoices):
    ALL_DAY    = "ALL_DAY",    "All Day"
    FLEXIBLE   = "FLEXIBLE",   "Flexible"
    AT_TIME    = "AT_TIME",    "At Time"
    TIME_RANGE = "TIME_RANGE", "Time Range"


class TimelineActivityStatus(models.TextChoices):
    UPCOMING    = "UPCOMING",    "Upcoming"
    IN_PROGRESS = "IN_PROGRESS", "In Progress"
    DONE        = "DONE",        "Done"
    CANCELLED   = "CANCELLED",   "Cancelled"


class TimelineActivityAssigneeScope(models.TextChoices):
    NONE     = "NONE",     "Unassigned"
    USER     = "USER",     "User"
    EVERYONE = "EVERYONE", "Everyone"


class TimelineLocationMode(models.TextChoices):
    MANUAL     = "MANUAL",     "Manual"
    STRUCTURED = "STRUCTURED", "Structured"


class TimelineSystemType(models.TextChoices):
    TRANSPORTATION = "TRANSPORTATION", "Transportation"
    ACCOMMODATION  = "ACCOMMODATION",  "Accommodation"
    FOOD           = "FOOD",           "Food"
    SIGHTSEEING    = "SIGHTSEEING",    "Sightseeing"
    SHOPPING       = "SHOPPING",       "Shopping"
    CHECKIN_OUT    = "CHECKIN_OUT",    "Check-in / Check-out"
    FREE_TIME      = "FREE_TIME",      "Free Time"
    OTHER          = "OTHER",          "Other"


# -------- Models --------

class Trip(models.Model):
    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    name            = models.CharField(max_length=120)
    destination     = models.CharField(max_length=200)
    start_date      = models.DateField()
    end_date        = models.DateField()
    description     = models.TextField(blank=True, default="")
    # -------- Place / Cover Fields --------
    destination_provider     = models.CharField(max_length=32, blank=True, default="")
    destination_provider_id  = models.CharField(max_length=255, blank=True, default="")
    destination_lat          = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    destination_lng          = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    destination_country_code = models.CharField(max_length=2, blank=True, default="")
    cover_image_url          = models.CharField(max_length=500, blank=True, default="")
    # -------- End Place Fields --------
    currency_code   = models.CharField(max_length=3, default="VND")
    timezone        = models.CharField(max_length=64, default="Asia/Ho_Chi_Minh")
    budget_estimate = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    status          = models.CharField(
        max_length=12,
        choices=TripStatus.choices,
        default=TripStatus.PLANNING,
        db_index=True,
    )
    created_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="created_trips",
    )
    cancelled_at    = models.DateTimeField(null=True, blank=True)
    chat_change_sequence = models.BigIntegerField(
        default=0,
        validators=[
            MinValueValidator(0),
            MaxValueValidator(CHAT_CHANGE_SEQUENCE_MAX),
        ],
    )
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=Q(end_date__gte=F("start_date")),
                name="trip_end_date_gte_start_date",
            ),
            models.CheckConstraint(
                condition=Q(budget_estimate__isnull=True) | Q(budget_estimate__gte=0),
                name="trip_budget_estimate_non_negative",
            ),
            models.CheckConstraint(
                condition=(
                    Q(chat_change_sequence__gte=0)
                    & Q(chat_change_sequence__lte=CHAT_CHANGE_SEQUENCE_MAX)
                ),
                name="trip_chat_change_sequence_safe",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} ({self.status})"


class TripMember(models.Model):
    id        = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip      = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="memberships")
    user      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="trip_memberships",
    )
    role      = models.CharField(max_length=8, choices=TripRole.choices)
    status    = models.CharField(max_length=8, choices=MemberStatus.choices, default=MemberStatus.ACTIVE)
    joined_at = models.DateTimeField(auto_now_add=True)
    left_at   = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["joined_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "user"],
                condition=Q(status="ACTIVE"),
                name="tripmember_unique_active_per_trip",
            )
        ]
        indexes = [
            models.Index(fields=["trip", "status"]),
            models.Index(fields=["user", "status"]),
        ]

    def __str__(self) -> str:
        return f"{self.user_id} in {self.trip_id} ({self.role}/{self.status})"


class TripInvitation(models.Model):
    id           = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip         = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="invitations")
    inviter      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sent_trip_invitations",
    )
    invitee      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="received_trip_invitations",
    )
    status       = models.CharField(
        max_length=10,
        choices=InvitationStatus.choices,
        default=InvitationStatus.PENDING,
    )
    created_at   = models.DateTimeField(auto_now_add=True)
    responded_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "invitee"],
                condition=Q(status="PENDING"),
                name="tripinvitation_unique_pending_per_trip",
            )
        ]
        indexes = [
            models.Index(fields=["trip", "status"]),
            models.Index(fields=["invitee", "status"]),
        ]

    def __str__(self) -> str:
        return f"Invite {self.invitee_id} → {self.trip_id} ({self.status})"


# -------- Timeline Models --------

class TimelineSection(models.Model):
    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip            = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="timeline_sections")
    section_date    = models.DateField()
    label           = models.CharField(max_length=120)
    is_label_custom = models.BooleanField(default=False)
    position        = models.PositiveIntegerField(default=0)
    created_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    updated_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["section_date", "position", "created_at"]
        indexes = [
            models.Index(fields=["trip", "section_date", "position"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "section_date"],
                name="timeline_section_unique_date_per_trip",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.label} ({self.section_date})"


class TimelineCustomType(models.Model):
    id              = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip            = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="timeline_custom_types")
    name            = models.CharField(max_length=40)
    normalized_name = models.CharField(max_length=40)
    color_token     = models.CharField(max_length=24, default="slate")
    icon_key        = models.CharField(max_length=32, default="tag")
    is_active       = models.BooleanField(default=True)
    created_by      = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at      = models.DateTimeField(auto_now_add=True)
    updated_at      = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["name", "created_at"]
        indexes = [
            models.Index(fields=["trip", "is_active"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["trip", "normalized_name"],
                name="timeline_custom_type_unique_name_per_trip",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.name} (trip={self.trip_id})"


class TimelineActivity(models.Model):
    id                   = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    trip                 = models.ForeignKey(Trip, on_delete=models.CASCADE, related_name="timeline_activities")
    section              = models.ForeignKey(TimelineSection, on_delete=models.CASCADE, related_name="activities")
    title                = models.CharField(max_length=140)
    time_mode            = models.CharField(max_length=16, choices=TimelineActivityTimeMode.choices)
    start_time           = models.TimeField(null=True, blank=True)
    end_time             = models.TimeField(null=True, blank=True)
    status               = models.CharField(
        max_length=16,
        choices=TimelineActivityStatus.choices,
        default=TimelineActivityStatus.UPCOMING,
    )
    system_type          = models.CharField(max_length=32, blank=True, default="")
    custom_type          = models.ForeignKey(
        TimelineCustomType,
        null=True, blank=True,
        on_delete=models.PROTECT,
        related_name="activities",
    )
    position             = models.PositiveIntegerField(default=0)
    assignee_scope       = models.CharField(
        max_length=16,
        choices=TimelineActivityAssigneeScope.choices,
        default=TimelineActivityAssigneeScope.NONE,
    )
    assignee_user        = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="assigned_timeline_activities",
    )
    location_mode        = models.CharField(
        max_length=16,
        choices=TimelineLocationMode.choices,
        default=TimelineLocationMode.MANUAL,
    )
    location_label       = models.CharField(max_length=200, blank=True, default="")
    location_note        = models.CharField(max_length=200, blank=True, default="")
    place_provider       = models.CharField(max_length=16, blank=True, default="")
    place_provider_id    = models.CharField(max_length=255, blank=True, default="")
    place_title          = models.CharField(max_length=200, blank=True, default="")
    place_address        = models.CharField(max_length=255, blank=True, default="")
    place_lat            = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    place_lng            = models.DecimalField(max_digits=9, decimal_places=6, null=True, blank=True)
    note                 = models.TextField(blank=True, default="")
    meeting_point        = models.CharField(max_length=200, blank=True, default="")
    contact_name         = models.CharField(max_length=120, blank=True, default="")
    contact_phone        = models.CharField(max_length=32, blank=True, default="")
    booking_reference    = models.CharField(max_length=120, blank=True, default="")
    external_link        = models.URLField(max_length=500, blank=True, default="")
    created_by           = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    updated_by           = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True, blank=True,
        on_delete=models.SET_NULL,
        related_name="+",
    )
    created_at           = models.DateTimeField(auto_now_add=True)
    updated_at           = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["position", "created_at"]
        indexes = [
            models.Index(fields=["section", "position"]),
            models.Index(fields=["trip", "status"]),
            models.Index(fields=["trip", "assignee_user"]),
        ]

    def __str__(self) -> str:
        return f"{self.title} (trip={self.trip_id})"


class TimelineActivityReminder(models.Model):
    id                    = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    activity              = models.ForeignKey(TimelineActivity, on_delete=models.CASCADE, related_name="reminders")
    offset_minutes_before = models.PositiveIntegerField()
    due_at_utc            = models.DateTimeField(db_index=True)
    sent_at               = models.DateTimeField(null=True, blank=True)
    created_at            = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["offset_minutes_before", "created_at"]
        indexes = [
            models.Index(fields=["sent_at", "due_at_utc"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["activity", "offset_minutes_before", "due_at_utc"],
                name="timeline_activity_reminder_unique_due_offset",
            ),
        ]

    def __str__(self) -> str:
        return f"Reminder {self.offset_minutes_before}m before activity={self.activity_id}"
